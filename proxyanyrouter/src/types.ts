export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface ProxyAnyRouterConfig {
  port: number;
  upstreamUrl: string;
  upstreamApiKey: string;
  mcpConfigPath: string;
  logDir: string;
  heartbeatMs: number;
  maxBridgeSteps: number;
  continuationMode: "replay" | "previous_response_id";
}

export interface McpBridgeActionReadFile {
  type: "read_file";
  path: string;
}

export interface McpBridgeActionReadFileArg {
  type: "read_file_arg";
  path_argument: string;
  allowed_roots?: string[];
}

export type McpBridgeAction = McpBridgeActionReadFile | McpBridgeActionReadFileArg;

export interface McpBridgeToolConfig {
  name: string;
  description: string;
  input_schema?: JsonObject;
  action: McpBridgeAction;
}

export interface McpBridgeServerConfig {
  server: string;
  description?: string;
  tools: McpBridgeToolConfig[];
}

export interface McpBridgeConfigFile {
  servers: McpBridgeServerConfig[];
}

export interface McpBridgeTool {
  namespace: string;
  qualifiedName: string;
  server: string;
  name: string;
  description: string;
  inputSchema: JsonObject;
  action: McpBridgeAction;
}

export interface McpBridgeRegistry {
  configPath: string;
  configDir: string;
  toolsByQualifiedName: Map<string, McpBridgeTool>;
  toolsByNamespace: Map<string, Map<string, McpBridgeTool>>;
}
