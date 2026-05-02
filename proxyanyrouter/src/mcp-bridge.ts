import type {
  JsonObject,
  JsonValue,
  McpBridgeConfigFile,
  McpBridgeRegistry,
  McpBridgeTool,
  McpBridgeToolConfig,
} from "./types.ts";

function objectValue(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeSchema(schema: JsonValue | undefined): JsonObject {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as JsonObject;
  }
  return { type: "object", properties: {}, required: [] };
}

function namespaceFor(server: string): string {
  return `mcp__${server}__`;
}

function qualify(namespace: string, toolName: string): string {
  return `${namespace}${toolName}`;
}

function serializeJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

function isPathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

async function realPathIfExists(path: string): Promise<string> {
  return await Deno.realPath(path);
}

function resolveFromConfigDir(configDir: string, rawPath: string): string {
  if (rawPath.startsWith("/")) return rawPath;
  return new URL(rawPath, `file://${configDir.replace(/\/+$/, "")}/`).pathname;
}

function formatReadFileOutput(path: string, content: string): string {
  return [`FILE: ${path}`, "", content].join("\n");
}

let cachedRegistry: McpBridgeRegistry | undefined;
let cachedRegistryMtime: number | undefined;

export async function loadBridgeRegistry(configPath: string): Promise<McpBridgeRegistry> {
  const stat = await Deno.stat(configPath);
  const mtime = stat.mtime?.getTime() ?? stat.birthtime?.getTime() ?? Date.now();
  if (
    cachedRegistry &&
    cachedRegistry.configPath === configPath &&
    cachedRegistryMtime === mtime
  ) {
    return cachedRegistry;
  }

  const raw = await Deno.readTextFile(configPath);
  const parsed = JSON.parse(raw) as McpBridgeConfigFile;
  const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
  const configDir = configPath.replace(/\/[^/]+$/, "");
  const toolsByQualifiedName = new Map<string, McpBridgeTool>();
  const toolsByNamespace = new Map<string, Map<string, McpBridgeTool>>();

  for (const server of servers) {
    if (!server || typeof server !== "object") continue;
    const serverName = stringValue(server.server);
    if (!serverName) continue;
    const namespace = namespaceFor(serverName);
    const childTools = new Map<string, McpBridgeTool>();
    const tools = Array.isArray(server.tools) ? server.tools : [];
    for (const toolValue of tools) {
      const tool = toolValue;
      const toolName = stringValue(tool.name);
      const description = stringValue(tool.description) ?? "";
      if (!toolName) continue;
      const inputSchema = normalizeSchema(tool.input_schema);
      const action = objectValue(tool.action as unknown as JsonValue);
      const actionType = stringValue(action.type);
      if (actionType !== "read_file" && actionType !== "read_file_arg") continue;

      const normalizedAction: McpBridgeToolConfig["action"] = actionType === "read_file"
        ? {
          type: "read_file",
          path: resolveFromConfigDir(
            configDir,
            stringValue(action.path) ?? "",
          ),
        }
        : {
          type: "read_file_arg",
          path_argument: stringValue(action.path_argument) ?? "path",
          allowed_roots: Array.isArray(action.allowed_roots)
            ? action.allowed_roots.filter((item): item is string =>
              typeof item === "string" && item.trim().length > 0
            ).map((item) => resolveFromConfigDir(configDir, item))
            : undefined,
        };

      const bridgeTool: McpBridgeTool = {
        namespace,
        qualifiedName: qualify(namespace, toolName),
        server: serverName,
        name: toolName,
        description,
        inputSchema,
        action: normalizedAction,
      };
      childTools.set(toolName, bridgeTool);
      toolsByQualifiedName.set(bridgeTool.qualifiedName, bridgeTool);
    }
    toolsByNamespace.set(namespace, childTools);
  }

  cachedRegistry = {
    configPath,
    configDir,
    toolsByQualifiedName,
    toolsByNamespace,
  };
  cachedRegistryMtime = mtime;
  return cachedRegistry;
}

export function flattenBridgeToolsInRequest(
  request: JsonObject,
  registry: McpBridgeRegistry,
): JsonObject {
  const rewritten: JsonObject = { ...request };
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const nextTools: JsonValue[] = [];

  for (const toolValue of tools) {
    const tool = objectValue(toolValue);
    const type = stringValue(tool.type);
    const name = stringValue(tool.name);
    if (type !== "namespace" || !name || !registry.toolsByNamespace.has(name)) {
      nextTools.push(toolValue);
      continue;
    }

    const namespaceTools = registry.toolsByNamespace.get(name)!;
    const childTools = Array.isArray(tool.tools) ? tool.tools : [];
    for (const childValue of childTools) {
      const child = objectValue(childValue);
      const childName = stringValue(child.name);
      if (!childName) continue;
      const bridgeTool = namespaceTools.get(childName);
      if (!bridgeTool) continue;
      nextTools.push({
        type: "function",
        name: bridgeTool.qualifiedName,
        description: [
          stringValue(child.description) ?? bridgeTool.description,
          `Bridge source namespace: ${name}`,
        ].filter(Boolean).join("\n\n"),
        parameters: normalizeSchema(child.parameters ?? bridgeTool.inputSchema),
      });
    }
  }

  rewritten.tools = nextTools;
  return rewritten;
}

export function extractBridgeCall(
  itemValue: JsonValue,
  registry: McpBridgeRegistry,
): { callId: string; qualifiedName: string; argumentsJson: string } | undefined {
  const item = objectValue(itemValue);
  if (stringValue(item.type) !== "function_call") return undefined;
  const callId = stringValue(item.call_id);
  if (!callId) return undefined;

  const namespace = stringValue(item.namespace);
  const name = stringValue(item.name);
  if (!name) return undefined;

  const qualifiedName = namespace ? qualify(namespace, name) : name;
  if (!registry.toolsByQualifiedName.has(qualifiedName)) return undefined;

  const argumentsJson = typeof item.arguments === "string"
    ? item.arguments
    : serializeJson(item.arguments ?? {});
  return { callId, qualifiedName, argumentsJson };
}

export function isAnyFunctionCall(itemValue: JsonValue): boolean {
  const item = objectValue(itemValue);
  return stringValue(item.type) === "function_call";
}

export async function executeBridgeCall(
  call: { qualifiedName: string; argumentsJson: string },
  registry: McpBridgeRegistry,
): Promise<string> {
  const bridgeTool = registry.toolsByQualifiedName.get(call.qualifiedName);
  if (!bridgeTool) {
    throw new Error(`Unknown bridge tool: ${call.qualifiedName}`);
  }

  let args: JsonObject = {};
  if (call.argumentsJson.trim()) {
    const parsed = JSON.parse(call.argumentsJson) as JsonValue;
    args = objectValue(parsed);
  }

  if (bridgeTool.action.type === "read_file") {
    const real = await realPathIfExists(bridgeTool.action.path);
    const content = await Deno.readTextFile(real);
    return formatReadFileOutput(real, content);
  }

  const pathArgName = bridgeTool.action.path_argument;
  const rawPath = stringValue(args[pathArgName]);
  if (!rawPath) {
    throw new Error(
      `Bridge tool ${bridgeTool.qualifiedName} requires string argument ${pathArgName}.`,
    );
  }
  const real = await realPathIfExists(rawPath);
  const allowedRoots = bridgeTool.action.allowed_roots ?? [];
  if (allowedRoots.length > 0) {
    const resolvedRoots = await Promise.all(allowedRoots.map((root) => realPathIfExists(root)));
    const allowed = resolvedRoots.some((root) => isPathWithinRoot(real, root));
    if (!allowed) {
      throw new Error(
        `Path ${real} is outside the allowed roots for ${bridgeTool.qualifiedName}.`,
      );
    }
  }
  const content = await Deno.readTextFile(real);
  return formatReadFileOutput(real, content);
}
