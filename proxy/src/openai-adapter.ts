import type {
  JsonObject,
  JsonValue,
  OpenAIChatRequest,
  OpenAIMessage,
  ProxyConfig,
  RequestContext,
} from "./types.ts";
import { augmentError, jsonResponse } from "./http.ts";
import { logError, logInfo, logWarn } from "./logger.ts";

function objectBody(ctx: RequestContext): JsonObject {
  return ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? ctx.body : {};
}

function text(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}


function collectReasoningFields(value: JsonObject): string[] {
  const output: string[] = [];
  for (const key of ["reasoning_content", "reasoning", "thinking", "reason"]) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) output.push(field.trim());
    else if (field && typeof field === "object" && !Array.isArray(field)) {
      const nested = field as JsonObject;
      const nestedText = text(nested.content ?? nested.summary ?? nested.text);
      if (nestedText.trim()) output.push(nestedText.trim());
    }
  }
  return output;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function addIfPresent(parts: string[], label: string, value: JsonValue | undefined): void {
  const rendered = text(value).trim();
  if (rendered) parts.push(`${label}:\n${rendered}`);
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.6);
  const tail = Math.max(0, maxChars - head);
  return `${value.slice(0, head)}\n\n... [truncated ${value.length - maxChars} chars] ...\n\n${value.slice(value.length - tail)}`;
}

function sanitizeUpstreamText(config: ProxyConfig, value: string): string {
  if (!config.sanitizeUpstreamPrompts) return value;
  return value
    .replace(/augment\.mjs/gi, "codex-cli")
    .replace(/\bAugment\s+Code\b/gi, config.upstreamAppName)
    .replace(/\bAuggie\b/gi, config.upstreamAppName);
}

function sanitizeMessages(config: ProxyConfig, messages: OpenAIMessage[]): OpenAIMessage[] {
  return messages.map((message) => ({
    ...message,
    content: sanitizeUpstreamText(config, message.content),
  }));
}

function nodeText(node: JsonValue): string {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "";
  const record = node as JsonObject;
  if (record.tool_result_node) return "";
  const textNode = record.text_node;
  if (textNode && typeof textNode === "object" && !Array.isArray(textNode)) return text((textNode as JsonObject).content);
  return text(record.content);
}

function compactToolResultContent(content: string): string {
  return truncateMiddle(content, 4_000);
}

function nodeToolUse(node: JsonValue): JsonObject | undefined {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  const record = node as JsonObject;
  const toolUse = record.tool_use;
  if (!toolUse || typeof toolUse !== "object" || Array.isArray(toolUse)) return undefined;
  const tool = toolUse as JsonObject;
  const name = typeof tool.tool_name === "string" ? tool.tool_name : "unknown";
  const id = typeof tool.tool_use_id === "string" ? tool.tool_use_id : `tool_${crypto.randomUUID()}`;
  const args = typeof tool.input_json === "string" ? tool.input_json : JSON.stringify(tool.input_json ?? {});
  return { id, type: "function", function: { name, arguments: args } };
}

function historyToMessages(history: JsonValue): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  for (const item of asArray(history)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as JsonObject;

    const requestNodes = asArray(record.request_nodes);
    const userText = requestNodes.map(nodeText).filter(Boolean).join("\n") || text(record.request_message).trim();
    if (userText) messages.push({ role: "user", content: userText });

    // Auggie stores tool results in the next turn's request_nodes. For OpenAI
    // chat-completions, those tool messages must appear immediately after the
    // assistant tool_calls that produced them, before the next assistant turn.
    appendToolResultMessages(messages, requestNodes);

    const responseNodes = asArray(record.response_nodes);
    const toolCalls = responseNodes.map(nodeToolUse).filter((call): call is JsonObject => Boolean(call));
    const responseText = responseNodes.map(nodeText).filter(Boolean).join("\n") || text(record.response_text).trim();
    if (responseText || toolCalls.length > 0) messages.push({ role: "assistant", content: responseText, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    if (messages.length === 0) {
      const roleRaw = text(record.role || record.speaker || record.type).toLowerCase();
      const role: "user" | "assistant" = roleRaw.includes("assistant") || roleRaw.includes("response") ? "assistant" : "user";
      const content = text(record.content || record.text || record.message).trim();
      if (content) messages.push({ role, content });
    }
  }
  return messages;
}

function appendToolResultMessages(messages: OpenAIMessage[], nodes: JsonValue): void {
  for (const node of asArray(nodes)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const toolResult = (node as JsonObject).tool_result_node;
    if (!toolResult || typeof toolResult !== "object" || Array.isArray(toolResult)) continue;
    const result = toolResult as JsonObject;
    const toolCallId = typeof result.tool_use_id === "string" ? result.tool_use_id : undefined;
    const content = compactToolResultContent(text(result.content));
    if (toolCallId) messages.push({ role: "tool", tool_call_id: toolCallId, content });
  }
}

function buildMessages(config: ProxyConfig, ctx: RequestContext): OpenAIMessage[] {
  const body = objectBody(ctx);
  const systemParts: string[] = [];
  addIfPresent(systemParts, "System prompt", body.system_prompt);
  addIfPresent(systemParts, "System prompt append", body.system_prompt_append);
  addIfPresent(systemParts, "User guidelines", body.user_guidelines);
  addIfPresent(systemParts, "Workspace guidelines", body.workspace_guidelines);
  addIfPresent(systemParts, "Rules", body.rules);
  addIfPresent(systemParts, "Skills", body.skills);
  systemParts.push(toolUseSystemPrompt(ctx));

  const messages: OpenAIMessage[] = [];
  if (systemParts.length > 0) messages.push({ role: "system", content: sanitizeUpstreamText(config, systemParts.join("\n\n")) });
  messages.push(...sanitizeMessages(config, pruneOrphanToolMessages(historyToMessages(body.chat_history))));
  appendToolResultMessages(messages, body.nodes);

  const userParts: string[] = [];
  addIfPresent(userParts, "Message", body.message || body.prompt || body.instruction);
  addIfPresent(userParts, "Path", body.path);
  addIfPresent(userParts, "Language", body.lang || body.language);
  addIfPresent(userParts, "Selected code", body.selected_code || body.selected_text);
  addIfPresent(userParts, "Prefix", body.prefix);
  addIfPresent(userParts, "Suffix", body.suffix);
  addIfPresent(userParts, "Nodes", body.nodes);
  addIfPresent(userParts, "Blobs", body.blobs);
  addIfPresent(userParts, "User guided blobs", body.user_guided_blobs);

  const userContent = userParts.length > 0 ? userParts.join("\n\n") : "Continue.";
  messages.push({ role: "user", content: sanitizeUpstreamText(config, userContent) });
  return messages;
}

function pruneOrphanToolMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  const output: OpenAIMessage[] = [];
  const pendingToolIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      const messageRecord = message as unknown as JsonObject;
      const toolCalls = Array.isArray(messageRecord.tool_calls) ? messageRecord.tool_calls as JsonValue[] : [];
      for (const call of toolCalls) {
        if (!call || typeof call !== "object" || Array.isArray(call)) continue;
        const id = (call as JsonObject).id;
        if (typeof id === "string" && id) pendingToolIds.add(id);
      }
      output.push(message);
      continue;
    }
    if (message.role === "tool") {
      const id = (message as unknown as JsonObject).tool_call_id;
      if (typeof id === "string" && pendingToolIds.has(id)) {
        pendingToolIds.delete(id);
        output.push(message);
      }
      continue;
    }
    output.push(message);
  }
  return output;
}

function hasPriorTurns(ctx: RequestContext): boolean {
  const body = objectBody(ctx);
  if (asArray(body.chat_history).length > 0) return true;
  for (const node of asArray(body.nodes)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    if ((node as JsonObject).tool_result_node) return true;
  }
  return false;
}

function hasDirectoryListingResult(ctx: RequestContext, path: string): boolean {
  const body = objectBody(ctx);
  const normalized = cleanExtractedPath(path);
  const isListingText = (content: string): boolean => {
    if (!content) return false;
    const lower = content.toLowerCase();
    if (!lower.includes("files and directories")) return false;
    return content.includes(normalized);
  };

  for (const node of asArray(body.nodes)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const result = (node as JsonObject).tool_result_node;
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    const content = text((result as JsonObject).content);
    if (isListingText(content)) return true;
  }

  for (const item of asArray(body.chat_history).slice(-10)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as JsonObject;
    for (const node of asArray(record.request_nodes)) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const result = (node as JsonObject).tool_result_node;
      if (!result || typeof result !== "object" || Array.isArray(result)) continue;
      const content = text((result as JsonObject).content);
      if (isListingText(content)) return true;
    }
  }

  return false;
}

function toolUseSystemPrompt(ctx: RequestContext): string {
  const body = objectBody(ctx);
  const workspacePath = typeof body.path === "string" && body.path ? body.path : undefined;
  const toolDefinitions = Array.isArray(body.tool_definitions) ? body.tool_definitions : [];
  const toolSummaries = toolDefinitions
    .filter((item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item) && typeof (item as JsonObject).name === "string")
    .map((tool) => toolPromptSummary(tool))
    .filter(Boolean);

  const lines = [
    "Auggie/Codex-style tool protocol:",
    "- You are an autonomous coding agent. Keep working until the user's request is fully resolved; do not stop after only announcing a plan or after one tool call.",
    "- Before using tools, briefly state what you are about to inspect or do. After tool results, continue from those exact results instead of repeating the same call.",
    "- Use tools only through the provided function-calling interface. Do not write XML, Markdown tool blocks, or prose pretending to be a tool call.",
    "- Every function call argument must be one complete JSON object that satisfies the tool schema. Never call a tool with {} unless that tool schema explicitly has no required fields.",
    "- Do not invent paths. Use paths from the current request, conversation, workspace context, search results, or directory listings.",
    "- Path safety policy: never access /, /home, or any path outside /home/<current-user>/. Restrict file and directory operations to the current user's home workspace only.",
    "- If a required argument is unknown, first use a discovery tool with a known directory/path or answer from available context; do not emit an invalid call.",
    "- If a tool fails validation, repair the next tool call by providing the missing required JSON field; do not repeat the same invalid call.",
    "- For project evaluation, inspect the workspace root/directory first, then read specific files discovered from listings, then synthesize a final answer.",
    "- Final-answer format is mandatory: after the main answer, append a section titled \"Next Steps\" with 1-3 numbered, concrete, executable follow-up actions tailored to the user's goal. Do not omit this section.",
    "- If you already have a directory listing result, do not call view on the same root directory again in later turns. Move forward by reading specific files or using codebase-retrieval with a concrete information_request.",
  ];
  if (workspacePath) {
    lines.push(`- Current workspace/path from the client: ${workspacePath}. Use it as the starting directory when you need to inspect this project.`);
    if (!hasPriorTurns(ctx) && !hasDirectoryListingResult(ctx, workspacePath)) {
      lines.push(`- For the initial directory inspection only, call view with {"path":"${workspacePath}","type":"directory"}. Do not repeat that same directory call in later turns unless new information requires it.`);
    } else if (hasDirectoryListingResult(ctx, workspacePath)) {
      lines.push(`- Directory listing for ${workspacePath} is already available in prior tool results. Do NOT call view on ${workspacePath} again; continue with concrete files/subdirectories from that listing.`);
    }
  }
  lines.push(
    "Critical tool argument formats:",
    "- view: requires a concrete path. Valid examples: {\"path\":\"<known-file>\",\"type\":\"file\"} or {\"path\":\"<known-directory>\",\"type\":\"directory\"}. Invalid: {}, {\"type\":\"file\"}, {\"path\":\"\"}.",
    "- view-range-untruncated: requires reference_id, start_line, end_line from a prior view result. Do not pass path to this tool.",
    "- codebase-retrieval: requires information_request. Valid example: {\"information_request\":\"Find the modules responsible for request routing, OpenAI adaptation, indexing, and configuration.\"}. Invalid: {}.",
    "- launch-process: requires command. Prefer simple commands and set cwd only when known. Valid example: {\"command\":\"pwd && ls -la\",\"cwd\":\"<known-directory>\"}.",
    "- save-file / str-replace-editor: only use when editing is explicitly needed, and provide the complete required schema fields.",
  );
  if (toolSummaries.length > 0) {
    lines.push("Available tool schemas from this client:");
    lines.push(...toolSummaries.slice(0, 30));
  }
  return lines.join("\n");
}

function toolPromptSummary(tool: JsonObject): string {
  const name = typeof tool.name === "string" ? normalizeToolName(tool.name) : "unknown";
  const schema = parseToolSchema(tool);
  const required = Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [];
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? Object.keys(schema.properties as JsonObject)
    : [];
  const requiredText = required.length > 0 ? required.join(", ") : "none";
  const propertyText = properties.length > 0 ? properties.slice(0, 12).join(", ") : "unspecified";
  return `- ${name}: required=[${requiredText}], fields=[${propertyText}]`;
}


function parseToolSchema(tool: JsonObject): JsonObject {
  const schema = tool.input_schema_json;
  if (typeof schema === "string" && schema.trim()) {
    try {
      const parsed = JSON.parse(schema) as JsonObject;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return { type: "object", properties: {} };
    }
  }
  const inputSchema = tool.input_schema;
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) return inputSchema as JsonObject;
  const parameters = tool.parameters;
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) return parameters as JsonObject;
  return { type: "object", properties: {} };
}

function buildOpenAITools(ctx: RequestContext): JsonObject[] {
  const body = objectBody(ctx);
  const toolDefinitions = Array.isArray(body.tool_definitions) ? body.tool_definitions : [];
  const tools: JsonObject[] = [];
  for (const item of toolDefinitions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const tool = item as JsonObject;
    if (typeof tool.name !== "string" || !tool.name) continue;
    tools.push({
      type: "function",
      function: {
        name: tool.name,
        description: toolDescriptionForModel(tool),
        parameters: parseToolSchema(tool),
      },
    });
  }
  return tools;
}

function toolDescriptionForModel(tool: JsonObject): string {
  const base = typeof tool.description === "string" ? tool.description.trim() : "";
  const name = typeof tool.name === "string" ? normalizeToolName(tool.name) : "unknown";
  const schema = parseToolSchema(tool);
  const required = Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") as string[] : [];
  const requirements = required.length > 0
    ? `Required JSON fields: ${required.join(", ")}. Do not call this tool unless every required field is present and non-empty.`
    : "This tool has no required JSON fields; use {} only if no optional fields are needed.";
  const examples: Record<string, string> = {
    "view": 'Example arguments: {"path":"<known-file-or-directory>","type":"file"}. Never use {}.',
    "view-range-untruncated": 'Example arguments: {"reference_id":"<reference-id>","start_line":1,"end_line":80}. Never pass path. Never use {}.',
    "codebase-retrieval": 'Example arguments: {"information_request":"Find files and modules relevant to the user request."}. Never use {}.',
    "launch-process": 'Example arguments: {"command":"pwd && ls -la","wait":true,"max_wait_seconds":60,"cwd":"<known-directory>"}. Never use {} or an empty command.',
    "read-process": 'Example arguments: {"terminal_id":1,"wait":true,"max_wait_seconds":60}. Never use undefined terminal_id.',
    "kill-process": 'Example arguments: {"terminal_id":1}. Never use undefined terminal_id.',
    "write-process": 'Example arguments: {"terminal_id":1,"input_text":"text"}. Never use undefined terminal_id.',
  };
  const example = examples[name] ?? "Arguments must be a valid JSON object matching the schema.";
  return [base, requirements, example].filter(Boolean).join("\n\n");
}


function splitThinkingTags(content: string): { visible: string; thinking: string[] } {
  const thinking: string[] = [];
  let visible = content;
  const patterns = [
    /<think(?:ing)?[^>]*>([\s\S]*?)<\/think(?:ing)?>/gi,
    /<reason[^>]*>([\s\S]*?)<\/reason>/gi,
  ];
  for (const pattern of patterns) {
    visible = visible.replace(pattern, (_match, inner: string) => {
      const text = String(inner ?? "").trim();
      if (text) thinking.push(text);
      return "";
    });
  }
  return { visible: visible.trim(), thinking };
}

function thinkingNodes(thinking: string[], startingId = 1000): JsonObject[] {
  return thinking.map((content, index) => ({
    id: startingId + index,
    type: 8,
    thinking: { content },
  }));
}

function workspaceFallbackPath(ctx: RequestContext): string | undefined {
  const body = objectBody(ctx);
  if (typeof body.path === "string" && body.path) {
    const extracted = firstAbsolutePathFromText(body.path);
    if (extracted) return extracted;
    return body.path;
  }
  const discovered = collectWorkspacePaths(body);
  return discovered[0];
}

function collectWorkspacePaths(value: JsonValue, output: string[] = [], seen = new Set<JsonValue>()): string[] {
  if (output.length >= 20 || value === null || value === undefined) return output;
  if (typeof value === "string") {
    for (const match of value.matchAll(/\/[^\s"'`<>]+/g)) {
      const path = cleanExtractedPath(match[0]);
      if (path.includes("/home/") || path.includes("/workspace") || path.includes("/projects/")) {
        if (!output.includes(path)) output.push(path);
      }
    }
    return output;
  }
  if (typeof value !== "object") return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectWorkspacePaths(item, output, seen);
    return output;
  }
  const record = value as JsonObject;
  for (const key of ["path", "cwd", "workspace", "workspace_path", "root", "root_path", "project_path"]) {
    const item = record[key];
    if (typeof item === "string" && item.startsWith("/")) {
      const path = cleanExtractedPath(item);
      if (!output.includes(path)) output.push(path);
    }
  }
  for (const item of Object.values(record)) collectWorkspacePaths(item, output, seen);
  return output;
}

function normalizeCommandCandidate(command: string): string | undefined {
  const trimmed = command.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!trimmed) return undefined;
  if (trimmed.length > 300) return undefined;
  return trimmed;
}

function isLikelyShellCommand(command: string): boolean {
  if (!command) return false;
  if (/[{}[\]]/.test(command)) return false;
  if (/^https?:\/\//i.test(command)) return false;
  if (/[;&|><]/.test(command)) return true;
  const firstToken = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return [
    "pwd",
    "ls",
    "cat",
    "rg",
    "grep",
    "find",
    "git",
    "npm",
    "pnpm",
    "yarn",
    "deno",
    "node",
    "python",
    "python3",
    "bash",
    "sh",
    "head",
    "tail",
    "awk",
    "sed",
    "make",
    "docker",
    "curl",
  ].includes(firstToken);
}

function extractCommandFromText(input: string): string | undefined {
  const patterns = [
    /(?:\b(?:run|execute|command|cmd)\b|执行命令|运行命令|执行|运行)[^`"\n]{0,30}`([^`\n]{1,220})`/i,
    /(?:\b(?:run|execute|command|cmd)\b|执行命令|运行命令|执行|运行)[^"'“”\n]{0,30}[“"]([^"”\n]{1,220})[”"]/i,
    /(?:\b(?:run|execute|command|cmd)\b|执行命令|运行命令|执行|运行)[^"'“”\n]{0,30}['"]([^'"\n]{1,220})['"]/i,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const candidate = match?.[1] ? normalizeCommandCandidate(match[1]) : undefined;
    if (candidate && isLikelyShellCommand(candidate)) return candidate;
  }

  for (const match of input.matchAll(/`([^`\n]{1,220})`/g)) {
    const candidate = normalizeCommandCandidate(match[1]);
    if (candidate && isLikelyShellCommand(candidate)) return candidate;
  }

  for (const match of input.matchAll(/[“"]([^"”\n]{1,220})[”"]/g)) {
    const candidate = normalizeCommandCandidate(match[1]);
    if (candidate && isLikelyShellCommand(candidate)) return candidate;
  }

  return undefined;
}

function inferLaunchCommandFromContext(ctx: RequestContext): string | undefined {
  const body = objectBody(ctx);
  const texts: string[] = [];
  for (const key of ["message", "prompt", "instruction"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) texts.push(value);
  }
  for (const node of asArray(body.nodes)) {
    const rendered = nodeText(node).trim();
    if (rendered) texts.push(rendered);
  }
  for (const item of asArray(body.chat_history).slice(-4)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as JsonObject;
    for (const node of asArray(record.request_nodes)) {
      const rendered = nodeText(node).trim();
      if (rendered) texts.push(rendered);
    }
    const requestMessage = text(record.request_message).trim();
    if (requestMessage) texts.push(requestMessage);
  }
  for (const value of texts) {
    const candidate = extractCommandFromText(value);
    if (candidate) return candidate;
  }
  return undefined;
}

function parseToolCall(
  call: JsonValue,
  fallbackPath?: string,
  launchCommandFallback?: string,
): { id: string; name: string; argumentsJson: string } | undefined {
  if (!call || typeof call !== "object" || Array.isArray(call)) return undefined;
  const record = call as JsonObject;
  const fn = record.function;
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) return undefined;
  const fnRecord = fn as JsonObject;
  const normalizedName = normalizeToolName(typeof fnRecord.name === "string" && fnRecord.name ? fnRecord.name : "unknown");
  let name = normalizedName;
  let argumentsJson = normalizeToolArguments(
    normalizedName,
    typeof fnRecord.arguments === "string" ? fnRecord.arguments : JSON.stringify(fnRecord.arguments ?? {}),
    fallbackPath,
    launchCommandFallback,
  );
  ({ name, argumentsJson } = repairMisusedToolCall(name, argumentsJson));
  const id = typeof record.id === "string" && record.id ? record.id : `tool_${crypto.randomUUID()}`;
  return { id, name, argumentsJson };
}

function normalizeToolName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/_/g, "-");
  const aliases: Record<string, string> = {
    bash: "launch-process",
    shell: "launch-process",
    run: "launch-process",
    exec: "launch-process",
    read: "view",
    "read-file": "view",
    open: "view",
    edit: "str-replace-editor",
    write: "save-file",
    "write-file": "save-file",
    search: "search-untruncated",
    grep: "search-untruncated",
    "view-tasklist": "view_tasklist",
    "reorganize-tasklist": "reorganize_tasklist",
    "update-tasks": "update_tasks",
    "add-tasks": "add_tasks",
  };
  return aliases[normalized] ?? normalized;
}

function normalizeToolArguments(
  toolName: string,
  argumentsJson: string,
  fallbackPath?: string,
  launchCommandFallback?: string,
): string {
  let args: JsonObject;
  try {
    const parsed = JSON.parse(repairArgumentsJson(argumentsJson) || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as JsonObject;
    } else if (typeof parsed === "string" && parsed.trim()) {
      try {
        const nested = JSON.parse(repairArgumentsJson(parsed));
        args = nested && typeof nested === "object" && !Array.isArray(nested) ? nested as JsonObject : {};
        if (Object.keys(args).length === 0) args.raw_input = parsed;
      } catch {
        args = { raw_input: parsed };
      }
    } else {
      args = {};
    }
  } catch {
    args = {};
    const pathMatch = argumentsJson.match(/(?:path|file_path|filepath|filename|file|absolute_path)\s*[:=]\s*["']?([^"'\n,}]+)["']?/i);
    if (pathMatch?.[1]) args.path = cleanExtractedPath(pathMatch[1]);
    else if (argumentsJson.trim().startsWith("/")) args.path = argumentsJson.trim();
    else if (argumentsJson.trim()) args.raw_input = argumentsJson;
  }

  if ((toolName === "view") && typeof args.path !== "string") {
    const candidate = args.file_path ?? args.filepath ?? args.filename ?? args.file ?? args.absolute_path;
    if (typeof candidate === "string") args.path = candidate;
    else if (fallbackPath) args.path = fallbackPath;
  }
  if ((toolName === "view") && typeof args.path === "string") args.path = repairViewPath(args.path, fallbackPath);
  if ((toolName === "view") && args.path === "." && fallbackPath) args.path = fallbackPath;
  if ((toolName === "view-range-untruncated") && typeof args.path === "string") args.path = repairViewPath(args.path, fallbackPath);
  if ((toolName === "launch-process") && typeof args.command !== "string") {
    const candidate = args.cmd ?? args.shell_command;
    const extracted = extractCommandFromText(argumentsJson);
    if (typeof candidate === "string") args.command = candidate;
    else if (extracted) args.command = extracted;
    else if (typeof args.raw_input === "string" && isLikelyShellCommand(args.raw_input)) args.command = args.raw_input;
    else if (launchCommandFallback) args.command = launchCommandFallback;
    else if (typeof args.cwd === "string") args.command = "pwd && ls -la";
  }
  if ((toolName === "launch-process") && typeof args.cwd === "string") args.cwd = repairViewPath(args.cwd, fallbackPath);
  if ((toolName === "launch-process") && typeof args.cwd !== "string" && fallbackPath) args.cwd = fallbackPath;
  if ((toolName === "launch-process") && typeof args.wait !== "boolean") args.wait = true;
  if ((toolName === "launch-process") && typeof args.max_wait_seconds !== "number") args.max_wait_seconds = 120;
  if (toolName === "codebase-retrieval" && typeof args.information_request !== "string") {
    args.information_request = "Provide an overview of this workspace and identify the key files relevant to the user's request.";
  }
  if (toolName === "codebase-retrieval" && typeof args.workspace_folder !== "string") {
    const workspaceFolder = workspaceFolderFromPath(fallbackPath);
    if (workspaceFolder) args.workspace_folder = workspaceFolder;
  }
  return JSON.stringify(args);
}

function repairMisusedToolCall(
  toolName: string,
  argumentsJson: string,
): { name: string; argumentsJson: string } {
  if (toolName !== "view-range-untruncated") return { name: toolName, argumentsJson };
  try {
    const parsed = JSON.parse(argumentsJson || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { name: toolName, argumentsJson };
    const args = parsed as JsonObject;
    const hasReferenceId = typeof args.reference_id === "string" && args.reference_id.trim() !== "";
    const hasStart = typeof args.start_line === "number";
    const hasEnd = typeof args.end_line === "number";
    const hasPath = typeof args.path === "string" && args.path.trim() !== "";
    if (!hasReferenceId && !hasStart && !hasEnd && hasPath) {
      const downgraded: JsonObject = { path: args.path };
      if (typeof args.type === "string" && args.type) downgraded.type = args.type;
      else downgraded.type = "file";
      return { name: "view", argumentsJson: JSON.stringify(downgraded) };
    }
  } catch {
    // Keep original tool call when arguments are not parseable.
  }
  return { name: toolName, argumentsJson };
}

function repairArgumentsJson(argumentsJson: string): string {
  const trimmed = argumentsJson.trim();
  if (!trimmed) return "{}";
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Continue with conservative repairs below.
  }
  if (trimmed.startsWith("{") && !trimmed.endsWith("}")) {
    const quoteCount = (trimmed.match(/(?<!\\)"/g) ?? []).length;
    return `${trimmed}${quoteCount % 2 === 1 ? '"' : ""}}`;
  }
  return trimmed;
}

function cleanExtractedPath(path: string): string {
  let cleaned = path.trim().replace(/^["'`]+|["'`]+$/g, "");
  cleaned = cleaned.replace(/["'`}\])]+$/g, "");
  cleaned = cleaned.replace(/\s+-\s+(?:read|view)\s+(?:file|directory)\s*$/i, "");
  cleaned = cleaned.replace(/\s+\|\s*(?:read|view)\s+(?:file|directory)\s*$/i, "");
  return cleaned.trim();
}

function firstAbsolutePathFromText(value: string): string | undefined {
  const matches = value.match(/(?:\/|[A-Za-z]:\/)[^\s"'`<>，。！？；;:(){}[\]]+/g) ?? [];
  for (const candidate of matches) {
    const cleaned = cleanExtractedPath(candidate);
    if (cleaned) return cleaned;
  }
  return undefined;
}

const VIEW_PATH_EXTENSION_CANDIDATES = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".go",
  ".rs",
  ".zig",
  ".py",
  ".pyi",
  ".rb",
  ".php",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".clj",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hpp",
  ".m",
  ".mm",
  ".swift",
  ".dart",
  ".lua",
  ".r",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".json",
  ".jsonc",
  ".toml",
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".yaml",
  ".yml",
  ".ini",
  ".cfg",
  ".conf",
  ".xml",
  ".html",
  ".css",
  ".scss",
  ".less",
];

function normalizePathSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function joinPath(base: string, child: string): string {
  if (!base) return child;
  if (!child) return base;
  if (base.endsWith("/")) return `${base}${child.replace(/^\/+/, "")}`;
  return `${base}/${child.replace(/^\/+/, "")}`;
}

function pathBasename(path: string): string {
  const normalized = normalizePathSlashes(path).replace(/\/+$/g, "");
  if (!normalized) return "";
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function pathDirname(path: string): string | undefined {
  const normalized = normalizePathSlashes(path).replace(/\/+$/g, "");
  if (!normalized) return undefined;
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return undefined;
  if (idx === 0) return "/";
  return normalized.slice(0, idx);
}

const WORKSPACE_MARKER_FILES = [
  ".git",
  "deno.json",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "build.zig",
  "README.md",
];

function pathExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function directoryExists(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

function hasFileExtension(path: string): boolean {
  return /\.[^/\\.]+$/.test(pathBasename(path));
}

function workspaceFolderFromPath(path?: string): string | undefined {
  if (!path) return undefined;
  let candidate = canonicalizePath(normalizePathSlashes(path.trim()));
  if (!candidate) return undefined;
  if (!directoryExists(candidate)) candidate = pathDirname(candidate) ?? candidate;
  if (!directoryExists(candidate)) return undefined;

  const homePrefix = allowedHomePrefix();
  const normalizedHome = homePrefix ? canonicalizePath(homePrefix) : undefined;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!directoryExists(candidate)) break;
    const hasMarker = WORKSPACE_MARKER_FILES.some((entry) => pathExists(joinPath(candidate, entry)));
    if (hasMarker) return candidate;
    const parent = pathDirname(candidate);
    if (!parent || parent === candidate) break;
    if (normalizedHome && (candidate === normalizedHome || !candidate.startsWith(`${normalizedHome}/`))) break;
    candidate = parent;
  }
  return directoryExists(candidate) ? candidate : undefined;
}

function extensionCompletionMatch(baseLower: string, nameLower: string): boolean {
  if (!nameLower.startsWith(baseLower) || nameLower === baseLower) return false;
  const suffix = nameLower.slice(baseLower.length);
  if (suffix.startsWith(".")) return true;
  if (!baseLower.includes(".")) return false;
  return /^[a-z0-9_-]+$/i.test(suffix);
}

function uniqueExtensionSibling(path: string): string | undefined {
  const dir = pathDirname(path);
  const base = pathBasename(path);
  if (!dir || !base || !directoryExists(dir)) return undefined;
  const baseLower = base.toLowerCase();
  const matches: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isFile) continue;
    const nameLower = entry.name.toLowerCase();
    if (extensionCompletionMatch(baseLower, nameLower)) matches.push(entry.name);
  }
  if (matches.length === 1) return joinPath(dir, matches[0]);
  if (matches.length > 1) return undefined;
  const stemIndex = baseLower.lastIndexOf("-");
  if (stemIndex <= 1) return undefined;
  const stem = baseLower.slice(0, stemIndex);
  const stemMatches: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isFile) continue;
    const nameLower = entry.name.toLowerCase();
    if (nameLower.startsWith(`${stem}-`)) stemMatches.push(entry.name);
  }
  if (stemMatches.length === 1) return joinPath(dir, stemMatches[0]);
  return undefined;
}

function uniqueDirectoryPrefixSibling(path: string): string | undefined {
  const dir = pathDirname(path);
  const base = pathBasename(path);
  if (!dir || !base || !directoryExists(dir)) return undefined;
  if (base.length < 2 || hasFileExtension(base)) return undefined;
  const baseLower = base.toLowerCase();
  const matches: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isDirectory) continue;
    const nameLower = entry.name.toLowerCase();
    if (nameLower.startsWith(baseLower)) matches.push(entry.name);
  }
  if (matches.length === 1) return joinPath(dir, matches[0]);
  return undefined;
}

function uniqueFilePrefixSibling(path: string): string | undefined {
  const dir = pathDirname(path);
  const base = pathBasename(path);
  if (!dir || !base || !directoryExists(dir)) return undefined;
  if (base.length < 2 || hasFileExtension(base)) return undefined;
  const baseLower = base.toLowerCase();
  const matches: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.isFile) continue;
    const nameLower = entry.name.toLowerCase();
    if (nameLower.startsWith(baseLower)) matches.push(entry.name);
  }
  if (matches.length === 1) return joinPath(dir, matches[0]);
  return undefined;
}

function canonicalizePath(path: string): string {
  let normalized = normalizePathSlashes(path).replace(/\/+/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/g, "");
  return normalized;
}

function allowedHomePrefix(): string | undefined {
  const user = (Deno.env.get("USER") ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!user) return undefined;
  return `/home/${user}`;
}

function allowedHomeHint(): string {
  const prefix = allowedHomePrefix();
  return prefix ? `${prefix}/...` : "/home/<user>/...";
}

function isPathWithinAllowedHome(path: string): boolean {
  const normalized = canonicalizePath(path);
  if (!isAbsolutePath(normalized)) return false;
  if (normalized === "/" || normalized === "/home") return false;
  const userPrefix = allowedHomePrefix();
  if (userPrefix) {
    const prefix = canonicalizePath(userPrefix);
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  }
  return /^\/home\/[^/]+(?:\/.*)?$/.test(normalized);
}

function repairViewPath(path: string, fallbackPath?: string): string {
  const cleaned = cleanExtractedPath(path);
  if (!cleaned) return cleaned;
  const fallback = fallbackPath ? normalizePathSlashes(fallbackPath.trim()) : undefined;
  const ordered: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value?: string) => {
    if (!value) return;
    const normalized = normalizePathSlashes(value.trim());
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    ordered.push(normalized);
  };

  addCandidate(cleaned);
  if (fallback && cleaned === ".") addCandidate(fallback);
  if (fallback && !isAbsolutePath(cleaned)) addCandidate(joinPath(fallback, cleaned.replace(/^\.\//, "")));

  for (const candidate of ordered) {
    if (pathExists(candidate)) return candidate;
  }

  const baseCandidates = [...ordered];
  for (const candidate of baseCandidates) {
    if (hasFileExtension(candidate)) continue;
    for (const ext of VIEW_PATH_EXTENSION_CANDIDATES) addCandidate(`${candidate}${ext}`);
  }

  for (const candidate of ordered) {
    if (pathExists(candidate)) return candidate;
  }
  for (const candidate of ordered) {
    const repaired = uniqueExtensionSibling(candidate);
    if (repaired) return repaired;
  }
  for (const candidate of ordered) {
    const repairedFile = uniqueFilePrefixSibling(candidate);
    if (repairedFile) return repairedFile;
  }
  for (const candidate of ordered) {
    const repairedDir = uniqueDirectoryPrefixSibling(candidate);
    if (repairedDir) return repairedDir;
  }
  for (const candidate of ordered) {
    const dir = pathDirname(candidate);
    const base = pathBasename(candidate);
    if (!dir || !directoryExists(dir)) continue;
    if (base.length <= 1) return dir;
    if (hasFileExtension(base)) return dir;
  }
  return cleaned;
}

function invalidToolReason(toolName: string, argumentsJson: string): string | undefined {
  try {
    const args = JSON.parse(argumentsJson || "{}") as JsonObject;
    if ((toolName === "view") && typeof args.path !== "string") {
      return `Tool ${toolName} requires a concrete path. Retry with valid JSON like {"path":"README.md","type":"file"}.`;
    }
    if ((toolName === "view") && typeof args.path === "string" && !isPathWithinAllowedHome(args.path)) {
      return `Tool ${toolName} path is outside the allowed scope. Use an absolute path under ${allowedHomeHint()}.`;
    }
    if ((toolName === "view") && typeof args.path === "string" && !pathExists(args.path)) {
      return `Tool ${toolName} path does not exist: ${args.path}. Use an existing path from a directory listing result.`;
    }
    if (toolName === "view-range-untruncated") {
      const missing = ["reference_id", "start_line", "end_line"].filter((key) => args[key] === undefined || args[key] === null || args[key] === "");
      if (missing.length > 0) return `Tool ${toolName} requires ${missing.join(", ")}.`;
      if (typeof args.path === "string" && args.path) {
        return `Tool ${toolName} does not accept path. Use {"reference_id":"<id>","start_line":1,"end_line":80}, or use view for path-based reads.`;
      }
    }
    if (toolName === "launch-process") {
      const missing = ["command", "wait", "max_wait_seconds", "cwd"].filter((key) => args[key] === undefined || args[key] === null || args[key] === "");
      if (missing.length > 0) return `Tool ${toolName} requires ${missing.join(", ")}. Retry with valid JSON like {"command":"pwd && ls -la","wait":true,"max_wait_seconds":60,"cwd":"/known/directory"}.`;
      if (typeof args.cwd === "string" && !isPathWithinAllowedHome(args.cwd)) {
        return `Tool ${toolName} cwd is outside the allowed scope. Use an absolute cwd under ${allowedHomeHint()}.`;
      }
    }
    if (toolName === "read-process") {
      const missing = ["terminal_id", "wait", "max_wait_seconds"].filter((key) => args[key] === undefined || args[key] === null || args[key] === "");
      if (missing.length > 0) return `Tool ${toolName} requires ${missing.join(", ")}. Retry only after launch-process returns a terminal_id.`;
    }
    if ((toolName === "kill-process" || toolName === "write-process") && (args.terminal_id === undefined || args.terminal_id === null || args.terminal_id === "")) {
      return `Tool ${toolName} requires terminal_id. Retry only after launch-process returns a terminal_id.`;
    }
    if (toolName === "write-process" && typeof args.input_text !== "string") {
      return `Tool ${toolName} requires input_text.`;
    }
    if (toolName === "web-fetch" && typeof args.url !== "string") return `Tool ${toolName} requires url.`;
    if (toolName === "search-untruncated") {
      const missing = ["reference_id", "search_term"].filter((key) => typeof args[key] !== "string" || args[key] === "");
      if (missing.length > 0) return `Tool ${toolName} requires ${missing.join(", ")}.`;
    }
    if (toolName === "codebase-retrieval" && typeof args.information_request !== "string") return `Tool ${toolName} requires information_request.`;
    if (toolName === "codebase-retrieval" && typeof args.workspace_folder !== "string") {
      return `Tool ${toolName} requires workspace_folder to avoid ambiguous workspace resolution.`;
    }
    if (toolName === "reorganize_tasklist" && typeof args.markdown !== "string") return `Tool ${toolName} requires markdown.`;
    if ((toolName === "update_tasks" || toolName === "add_tasks") && !Array.isArray(args.tasks)) return `Tool ${toolName} requires tasks array.`;
  } catch {
    return `Tool ${toolName} arguments are not valid JSON. Retry with a valid JSON object.`;
  }
  return undefined;
}

function toolCallsToNodes(
  toolCalls: JsonValue,
  startingId = 1,
  fallbackPath?: string,
  launchCommandFallback?: string,
): JsonObject[] {
  if (!Array.isArray(toolCalls)) return [];
  const nodes: JsonObject[] = [];
  let id = startingId;
  for (const call of toolCalls) {
    const parsed = parseToolCall(call, fallbackPath, launchCommandFallback);
    if (!parsed) continue;
    const invalidReason = invalidToolReason(parsed.name, parsed.argumentsJson);
    if (invalidReason) continue;
    nodes.push({
      id,
      type: 5,
      tool_use: {
        tool_name: parsed.name,
        tool_use_id: parsed.id,
        input_json: parsed.argumentsJson,
      },
    });
    id += 1;
  }
  return nodes;
}

function recentToolCallCounts(ctx: RequestContext, fallbackPath?: string): Map<string, number> {
  const counts = new Map<string, number>();
  const body = objectBody(ctx);
  for (const item of asArray(body.chat_history).slice(-8)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as JsonObject;
    for (const node of asArray(record.response_nodes)) {
      const call = nodeToolUse(node);
      if (!call) continue;
      const parsed = parseToolCall(call, fallbackPath);
      if (parsed) {
        const key = toolCallKey(parsed.name, parsed.argumentsJson);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function toolCallKey(name: string, argumentsJson: string): string {
  try {
    return `${name}:${JSON.stringify(JSON.parse(argumentsJson))}`;
  } catch {
    return `${name}:${argumentsJson}`;
  }
}

function filterRepeatedToolCalls(
  toolCalls: JsonObject[],
  recentCounts: Map<string, number>,
  fallbackPath?: string,
  launchCommandFallback?: string,
): { valid: JsonObject[]; repeated: JsonObject[] } {
  const valid: JsonObject[] = [];
  const repeated: JsonObject[] = [];
  for (const call of toolCalls) {
    const parsed = parseToolCall(call, fallbackPath, launchCommandFallback);
    if (!parsed) continue;
    const key = toolCallKey(parsed.name, parsed.argumentsJson);
    const seenCount = recentCounts.get(key) ?? 0;
    // Allow one repeat in case the model is reconciling tool output; start
    // filtering only after the same call has appeared multiple times.
    if (seenCount >= 2) repeated.push(call);
    else valid.push(call);
  }
  return { valid, repeated };
}

function invalidToolCallSummaries(toolCalls: JsonValue, fallbackPath?: string, launchCommandFallback?: string): JsonObject[] {
  if (!Array.isArray(toolCalls)) return [];
  const output: JsonObject[] = [];
  for (const call of toolCalls) {
    const parsed = parseToolCall(call, fallbackPath, launchCommandFallback);
    if (!parsed) continue;
    const reason = invalidToolReason(parsed.name, parsed.argumentsJson);
    if (reason) output.push({ id: parsed.id, name: parsed.name, arguments: parsed.argumentsJson, reason });
  }
  return output;
}

function invalidToolCallHint(invalidToolCalls: JsonObject[]): string | undefined {
  if (invalidToolCalls.length === 0) return undefined;
  const first = invalidToolCalls[0];
  const name = typeof first.name === "string" ? first.name : "unknown";
  const reason = typeof first.reason === "string" ? first.reason : "The tool-call arguments were invalid.";
  return `Tool call rejected (${name}): ${reason}`;
}

function hasMeaningfulVisibleText(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.length >= 16) return true;
  const semanticChars = (trimmed.match(/[A-Za-z0-9\u4E00-\u9FFF]/g) ?? []).length;
  return semanticChars >= 4;
}

function mergeStreamToolCalls(toolCalls: JsonObject[]): JsonObject[] {
  const byKey = new Map<string, JsonObject>();
  const order: string[] = [];
  let anonymousCounter = 0;
  let lastKey: string | undefined;

  const completeJsonObject = (value: string | undefined): boolean => {
    if (!value || !value.trim()) return false;
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  };

  for (const call of toolCalls) {
    const index = typeof call.index === "number" ? call.index : undefined;
    const id = typeof call.id === "string" && call.id ? call.id : undefined;
    const sourceFunction = call.function && typeof call.function === "object" && !Array.isArray(call.function)
      ? call.function as JsonObject
      : undefined;
    const sourceName = sourceFunction && typeof sourceFunction.name === "string" && sourceFunction.name ? sourceFunction.name : undefined;
    const sourceArguments = sourceFunction && typeof sourceFunction.arguments === "string" ? sourceFunction.arguments : undefined;

    let key: string | undefined;
    if (id && byKey.has(id)) key = id;
    else if (typeof index === "number") key = `index:${index}`;
    else if (id) key = id;
    else if (lastKey) {
      if (!sourceName) key = lastKey;
      else {
        const last = byKey.get(lastKey);
        const lastFn = last?.function && typeof last.function === "object" && !Array.isArray(last.function)
          ? last.function as JsonObject
          : undefined;
        const lastName = lastFn && typeof lastFn.name === "string" ? lastFn.name : "";
        const lastArgs = lastFn && typeof lastFn.arguments === "string" ? lastFn.arguments : undefined;
        if (!lastName || sourceName.startsWith(lastName) || lastName.startsWith(sourceName) || !completeJsonObject(lastArgs)) key = lastKey;
      }
    }
    if (!key) key = `anon:${anonymousCounter++}`;
    let merged = byKey.get(key);
    if (!merged) {
      merged = { id: id ?? `tool_${crypto.randomUUID()}`, type: "function", function: {} };
      byKey.set(key, merged);
      order.push(key);
    }

    if (id) merged.id = id;
    if (typeof call.type === "string") merged.type = call.type;

    if (!sourceFunction) continue;

    const mergedFunction = (merged.function && typeof merged.function === "object" && !Array.isArray(merged.function))
      ? merged.function as JsonObject
      : {};
    const mergedName = typeof mergedFunction.name === "string" ? mergedFunction.name : "";
    if (sourceName) {
      if (!mergedName) mergedFunction.name = sourceName;
      else if (sourceName === mergedName || mergedName.startsWith(sourceName)) mergedFunction.name = mergedName;
      else if (sourceName.startsWith(mergedName)) mergedFunction.name = sourceName;
      else mergedFunction.name = `${mergedName}${sourceName}`;
    }
    if (typeof sourceArguments === "string") {
      const mergedArgs = typeof mergedFunction.arguments === "string" ? mergedFunction.arguments : "";
      if (!mergedArgs) mergedFunction.arguments = sourceArguments;
      else if (sourceArguments === mergedArgs || mergedArgs.startsWith(sourceArguments)) mergedFunction.arguments = mergedArgs;
      else if (sourceArguments.startsWith(mergedArgs)) mergedFunction.arguments = sourceArguments;
      else mergedFunction.arguments = `${mergedArgs}${sourceArguments}`;
    }
    merged.function = mergedFunction;
    lastKey = key;
  }

  const mergedCalls = order.map((key) => byKey.get(key)).filter((call): call is JsonObject => {
    const fn = call?.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) return false;
    const record = fn as JsonObject;
    return typeof record.name === "string" && record.name.length > 0;
  });
  return dedupeToolCalls(mergedCalls);
}

function dedupeToolCalls(toolCalls: JsonObject[]): JsonObject[] {
  const seen = new Set<string>();
  const output: JsonObject[] = [];
  for (const call of toolCalls) {
    const fn = call.function;
    const fnRecord = fn && typeof fn === "object" && !Array.isArray(fn) ? fn as JsonObject : {};
    const name = typeof fnRecord.name === "string" ? normalizeToolName(fnRecord.name) : "unknown";
    const args = typeof fnRecord.arguments === "string" ? fnRecord.arguments : JSON.stringify(fnRecord.arguments ?? {});
    const key = `${name}:${args}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(call);
  }
  return output;
}

function renderToolCalls(toolCalls: JsonValue): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return toolCalls.map((call) => {
    const parsed = parseToolCall(call);
    if (!parsed) return "";
    return `<tool_call>\n<${parsed.name}>\n${parsed.argumentsJson}\n</${parsed.name}>\n</tool_call>`;
  }).filter(Boolean).join("\n");
}

function buildOpenAIRequest(config: ProxyConfig, ctx: RequestContext, stream: boolean): OpenAIChatRequest {
  const body = objectBody(ctx);
  const request: OpenAIChatRequest = {
    model: config.openaiModel,
    messages: buildMessages(config, ctx),
    stream,
  };
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.max_tokens === "number") request.max_tokens = body.max_tokens;
  const tools = buildOpenAITools(ctx);
  if (tools.length > 0) {
    request.tools = tools;
    request.tool_choice = "auto";
  }
  return request;
}

function openAIHeaders(config: ProxyConfig, stream: boolean): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${config.openaiApiKey}`);
  headers.set("content-type", "application/json");
  headers.set("accept", stream ? "text/event-stream" : "application/json");
  if (config.openaiUserAgent) headers.set("user-agent", config.openaiUserAgent);
  return headers;
}

function openAIUrl(config: ProxyConfig): string {
  return `${config.openaiBaseUrl}/chat/completions`;
}

function augmentStatus(status: number): number {
  if (status === 401 || status === 403) return 502;
  return status;
}

export async function forwardAugmentJson(config: ProxyConfig, ctx: RequestContext): Promise<Response> {
  const request = buildOpenAIRequest(config, ctx, false);
  const fallbackPath = workspaceFallbackPath(ctx);
  logInfo(config, "openai:json:start", { requestId: ctx.requestId, model: config.openaiModel, url: openAIUrl(config) });
  logInfo(config, "openai:json:payload", { requestId: ctx.requestId, messages: request.messages.length, tools: request.tools?.length ?? 0, bytes: JSON.stringify(request).length });
  const upstream = await fetch(openAIUrl(config), {
    method: "POST",
    headers: openAIHeaders(config, false),
    body: JSON.stringify(request),
  });

  const raw = await upstream.text();
  logInfo(config, "openai:json:end", { requestId: ctx.requestId, status: upstream.status });
  if (!upstream.ok) {
    return augmentError(`OpenAI upstream failed: ${raw.slice(0, 1000)}`, augmentStatus(upstream.status), "upstream_error");
  }

  let data: JsonObject;
  try {
    data = JSON.parse(raw) as JsonObject;
  } catch {
    return augmentError("OpenAI upstream returned invalid JSON", 502, "bad_upstream_json");
  }

  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0];
  let content = "";
  let nodes: JsonObject[] = [];
  let reasoningFallback = "";
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const message = (first as JsonObject).message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const messageRecord = message as JsonObject;
      content = text(messageRecord.content);
      const reasoning = collectReasoningFields(messageRecord);
      reasoningFallback = reasoning.join("\n\n").trim();
      if (reasoning.length > 0) nodes = [...thinkingNodes(reasoning), ...nodes];
      nodes = [...nodes, ...toolCallsToNodes(messageRecord.tool_calls, 1, fallbackPath)];
      if (nodes.length === 0) {
        const renderedToolCalls = renderToolCalls((message as JsonObject).tool_calls);
        if (renderedToolCalls) content = content ? `${content}\n${renderedToolCalls}` : renderedToolCalls;
      }
    }
    content ||= text((first as JsonObject).text);
  }

  const requestId = ctx.requestId;
  const split = splitThinkingTags(content);
  content = split.visible;
  if (!content && reasoningFallback && nodes.every((node) => !(node as JsonObject).tool_use)) {
    content = reasoningFallback;
    nodes = [];
  }
  nodes = [...thinkingNodes(split.thinking), ...nodes];
  return jsonResponse({
    text: content,
    response_text: content,
    completion: content,
    request_id: requestId,
    requestId,
    stop_reason: "stop",
    usage: data.usage ?? null,
    nodes,
  });
}

function sseEncode(value: JsonObject): string {
  return `${JSON.stringify(value)}\n`;
}

function renderDeltaToolCalls(toolCalls: JsonValue): string {
  return renderToolCalls(toolCalls);
}

function extractDelta(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return payload === "[DONE]" ? "" : undefined;
  try {
    const data = JSON.parse(payload) as JsonObject;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = choices[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return undefined;
    const delta = (first as JsonObject).delta;
    if (delta && typeof delta === "object" && !Array.isArray(delta)) {
      const content = text((delta as JsonObject).content);
      const toolText = renderDeltaToolCalls((delta as JsonObject).tool_calls);
      return content || toolText || undefined;
    }
    return text((first as JsonObject).text) || undefined;
  } catch {
    return undefined;
  }
}



class ThinkingStreamFilter {
  private mode: "visible" | "thinking" = "visible";
  private pending = "";
  private thinkingCurrent = "";
  private inlineCode = false;
  private fencedCode = false;
  readonly thinking: string[] = [];

  private consumeVisibleChar(): string {
    const char = this.pending[0];
    if (this.pending.startsWith("```")) {
      this.fencedCode = !this.fencedCode;
      this.pending = this.pending.slice(3);
      return "```";
    }
    if (!this.fencedCode && char === "`") this.inlineCode = !this.inlineCode;
    this.pending = this.pending.slice(1);
    return char;
  }

  private inCode(): boolean {
    return this.inlineCode || this.fencedCode;
  }

  push(input: string): string {
    this.pending += input;
    let visible = "";
    while (this.pending.length > 0) {
      if (this.mode === "visible") {
        if (this.inCode()) {
          visible += this.consumeVisibleChar();
          continue;
        }
        const open = this.pending.search(/<\/?(?:think|thinking|reason)\b/i);
        if (open < 0) {
          const keep = Math.min(this.pending.length, 16);
          const flushLen = Math.max(0, this.pending.length - keep);
          for (let index = 0; index < flushLen;) {
            if (this.pending.startsWith("```")) {
              visible += this.consumeVisibleChar();
              index += 3;
            } else {
              visible += this.consumeVisibleChar();
              index += 1;
            }
          }
          break;
        }
        for (let index = 0; index < open;) {
          if (this.pending.startsWith("```")) {
            visible += this.consumeVisibleChar();
            index += 3;
          } else {
            visible += this.consumeVisibleChar();
            index += 1;
          }
        }
        if (this.inCode()) continue;
        const match = this.pending.match(/^<(think|thinking|reason)\b[^>]*>/i);
        if (!match) {
          if (this.pending.length < 32) break;
          visible += this.consumeVisibleChar();
          continue;
        }
        this.pending = this.pending.slice(match[0].length);
        this.mode = "thinking";
        this.thinkingCurrent = "";
      } else {
        const close = this.pending.search(/<\/(?:think|thinking|reason)>/i);
        if (close < 0) {
          this.thinkingCurrent += this.pending;
          this.pending = "";
          break;
        }
        this.thinkingCurrent += this.pending.slice(0, close);
        const closeMatch = this.pending.slice(close).match(/^<\/(?:think|thinking|reason)>/i);
        this.pending = this.pending.slice(close + (closeMatch?.[0].length ?? 0));
        const thought = this.thinkingCurrent.trim();
        if (thought) this.thinking.push(thought);
        this.thinkingCurrent = "";
        this.mode = "visible";
      }
    }
    return visible;
  }

  flush(): { visible: string; thinking: string[] } {
    let visible = "";
    if (this.mode === "thinking") {
      const thought = (this.thinkingCurrent + this.pending).trim();
      if (thought) this.thinking.push(thought);
    } else {
      visible = this.pending;
    }
    this.pending = "";
    this.thinkingCurrent = "";
    this.mode = "visible";
    return { visible, thinking: this.thinking };
  }
}

function parseOpenAIStreamLine(line: string): { content?: string; thinking?: string[]; toolCalls?: JsonObject[]; done?: boolean; finishReason?: string } {
  if (!line.startsWith("data:")) return {};
  const payload = line.slice(5).trim();
  if (!payload) return {};
  if (payload === "[DONE]") return { done: true };
  try {
    const data = JSON.parse(payload) as JsonObject;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = choices[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return {};
    const finishReason = text((first as JsonObject).finish_reason) || undefined;
    const delta = (first as JsonObject).delta;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) return { finishReason };
    const deltaRecord = delta as JsonObject;
    return {
      content: text(deltaRecord.content) || undefined,
      thinking: collectReasoningFields(deltaRecord),
      toolCalls: Array.isArray(deltaRecord.tool_calls) ? deltaRecord.tool_calls as JsonObject[] : undefined,
      finishReason,
    };
  } catch {
    return {};
  }
}

export async function forwardAugmentStream(config: ProxyConfig, ctx: RequestContext): Promise<Response> {
  const request = buildOpenAIRequest(config, ctx, true);
  const requestId = ctx.requestId;
  const fallbackPath = workspaceFallbackPath(ctx);
  const streamToolCalls: JsonObject[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffer = "";
      const thinkingFilter = new ThinkingStreamFilter();
      const thinkingBuffer: string[] = [];
      let visibleText = "";
      let emittedVisibleText = false;
      let sawDone = false;
      let upstreamChunks = 0;
      let upstreamContentChars = 0;
      let finishReason = "";
      let closed = false;
      const safeEnqueue = (value: JsonObject) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseEncode(value)));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // stream already closed by client
        }
      };
      const heartbeat = setInterval(() => {
        safeEnqueue({ text: "", heartbeat: true, request_id: requestId });
      }, 5_000);

      // Send an immediate chunk so Augment receives response headers before its headers timeout.
      safeEnqueue({ text: "", heartbeat: true, request_id: requestId });

      void (async () => {
      try {
        let upstream: Response;
        try {
          logInfo(config, "openai:stream:start", { requestId, model: config.openaiModel, url: openAIUrl(config) });
          logInfo(config, "openai:stream:payload", { requestId, messages: request.messages.length, tools: request.tools?.length ?? 0, bytes: JSON.stringify(request).length });
          const waitLogger = setInterval(() => logInfo(config, "openai:stream:waiting-headers", { requestId }), 15_000);
          try {
            upstream = await fetch(openAIUrl(config), {
              method: "POST",
              headers: openAIHeaders(config, true),
              body: JSON.stringify(request),
            });
          } finally {
            clearInterval(waitLogger);
          }
        } catch (error) {
          logError(config, "openai:stream:fetch-error", { requestId, error: error instanceof Error ? error.message : String(error) });
          safeEnqueue({ error: `OpenAI stream request failed: ${error instanceof Error ? error.message : String(error)}`, request_id: requestId });
          finish();
          return;
        }

        logInfo(config, "openai:stream:headers", { requestId, status: upstream.status });

        if (!upstream.ok || !upstream.body) {
          const raw = await upstream.text().catch(() => "");
          logWarn(config, "openai:stream:bad-status", { requestId, status: upstream.status, body: raw.slice(0, 300) });
          safeEnqueue({ error: `OpenAI stream upstream failed: ${raw.slice(0, 1000)}`, request_id: requestId });
          finish();
          return;
        }

        const reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const parsed = parseOpenAIStreamLine(line);
            if (parsed.done) sawDone = true;
            if (parsed.finishReason) finishReason = parsed.finishReason;
            if (parsed.toolCalls?.length) streamToolCalls.push(...parsed.toolCalls);
            if (parsed.thinking?.length) thinkingBuffer.push(...parsed.thinking);
            if (parsed.content) {
              upstreamChunks += 1;
              upstreamContentChars += parsed.content.length;
              const visible = thinkingFilter.push(parsed.content);
              if (visible) {
                emittedVisibleText = true;
                visibleText += visible;
                safeEnqueue({ text: visible, delta: visible, request_id: requestId });
              }
            }
          }
        }
        const flushed = thinkingFilter.flush();
        if (flushed.visible) {
          emittedVisibleText = true;
          visibleText += flushed.visible;
          safeEnqueue({ text: flushed.visible, delta: flushed.visible, request_id: requestId });
        }
        const launchCommandFallback = inferLaunchCommandFromContext(ctx);
        const mergedToolCalls = mergeStreamToolCalls(streamToolCalls);
        if (streamToolCalls.length > 0) logInfo(config, "openai:stream:tool-calls", { requestId, fragments: streamToolCalls.length, merged: mergedToolCalls.length });
        const invalidToolCalls = invalidToolCallSummaries(mergedToolCalls, fallbackPath, launchCommandFallback);
        if (invalidToolCalls.length > 0) logWarn(config, "openai:stream:invalid-tool-calls-filtered", { requestId, invalidToolCalls });
        const nonInvalidToolCalls = mergedToolCalls.filter((call) => {
          const parsed = parseToolCall(call, fallbackPath, launchCommandFallback);
          return parsed && !invalidToolReason(parsed.name, parsed.argumentsJson);
        });
        const toolNodes = toolCallsToNodes(nonInvalidToolCalls, 1, fallbackPath, launchCommandFallback);
        if (toolNodes.length > 0) {
          logInfo(config, "openai:stream:tool-nodes", {
            requestId,
            nodes: toolNodes.map((node) => (node.tool_use as JsonObject | undefined)?.tool_name ?? "unknown"),
            inputs: toolNodes.map((node) => {
              const input = ((node.tool_use as JsonObject | undefined)?.input_json ?? "") as string;
              return { len: input.length, preview: input.slice(0, 120) };
            }),
            fallbackPathUsed: fallbackPath,
          });
        }
        if (!hasMeaningfulVisibleText(visibleText) && toolNodes.length === 0) {
          const invalidHint = invalidToolCallHint(invalidToolCalls);
          if (invalidHint) {
            visibleText += invalidHint;
            emittedVisibleText = true;
            safeEnqueue({ text: invalidHint, delta: invalidHint, request_id: requestId });
          }
        }
        const allThinking = [...thinkingBuffer, ...flushed.thinking].filter((item) => item.trim());
        logInfo(config, "openai:stream:end", { requestId, sawDone, finishReason, upstreamChunks, upstreamContentChars, thinkingItems: allThinking.length, toolFragments: streamToolCalls.length });
        if (!hasMeaningfulVisibleText(visibleText) && toolNodes.length === 0 && allThinking.length > 0) {
          const fallbackText = allThinking.join("\n\n");
          logWarn(config, "openai:stream:reasoning-as-text", { requestId, chars: fallbackText.length });
          visibleText += fallbackText;
          safeEnqueue({ text: fallbackText, delta: fallbackText, request_id: requestId });
          emittedVisibleText = true;
        }
        const thoughtNodes = hasMeaningfulVisibleText(visibleText) ? [] : thinkingNodes(allThinking);
        const finalNodes = [...thoughtNodes, ...toolNodes];
        if (!hasMeaningfulVisibleText(visibleText) && finalNodes.length === 0) {
          logWarn(config, "openai:stream:empty-keepalive", { requestId, sawDone, finishReason, upstreamChunks, upstreamContentChars });
          safeEnqueue({ text: "", heartbeat: true, empty_upstream: true, request_id: requestId });
          return;
        }
        if (finalNodes.length > 0) safeEnqueue({ text: "", nodes: finalNodes, request_id: requestId });
        logInfo(config, "openai:stream:final", { requestId, visibleChars: visibleText.length, nodes: finalNodes.length });
        const finalText = emittedVisibleText ? "" : visibleText;
        safeEnqueue({ text: finalText, response_text: visibleText, completion: visibleText, done: true, stop_reason: "stop", request_id: requestId });
        finish();
      } catch (error) {
        logError(config, "openai:stream:error", { requestId, error: String(error) });
        safeEnqueue({ error: String(error), request_id: requestId });
        finish();
      }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache",
      "x-request-id": requestId,
    },
  });
}

export async function forwardCompletion(config: ProxyConfig, ctx: RequestContext): Promise<Response> {
  const response = await forwardAugmentJson(config, ctx);
  if (!response.ok) return response;
  const data = await response.json() as JsonObject;
  const content = typeof data.text === "string" ? data.text : "";
  return jsonResponse({
    completion_items: [{ text: content }],
    completion: content,
    text: content,
    request_id: ctx.requestId,
  });
}
