export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type SwitchApi = "OPENAI" | "CODEX";

export interface ChannelConfig {
  baseUrl: string;
  apiKeys: string[];
  model?: string;
  modelMapping?: Record<string, string>;
}

export interface ProxyConfig {
  port: number;
  switchApi: SwitchApi;
  activeChannel: string;
  channels: Record<string, ChannelConfig>;
  modelMapping: Record<string, string>;
  openaiBaseUrl: string;
  codexBaseUrl: string;
  openaiApiKeys: string[];
  codexApiKey: string;
  openaiModel: string;
  codexModel: string;
  openaiUserAgent: string;
  upstreamAppName: string;
  sanitizeUpstreamPrompts: boolean;
  augmentModelContextTokens: number;
  augmentModelMaxOutputTokens: number;
  augmentHistoryTailTokens: number;
  augmentHistoryMaxChars: number;
  augmentHistorySummaryPrompt: string;
  fakeAugmentEmail: string;
  fakeAugmentUserId: string;
  requestLogDir: string;
  indexingMode: string;
  embedBaseUrl: string;
  embedApiKeys: string[];
  embedModel: string;
  embedDimensions: number;
  qdrantUrl: string;
  qdrantCollection: string;
  indexChunkChars: number;
  indexChunkOverlap: number;
  logLevel: string;
}

export interface RequestContext {
  requestId: string;
  method: string;
  url: URL;
  path: string;
  headers: Headers;
  body: JsonValue | undefined;
  rawBody: string;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: JsonObject[];
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: JsonObject[];
  tool_choice?: "auto" | "required";
  stream_options?: JsonObject;
}

export interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: JsonObject[];
  tools: JsonObject[];
  tool_choice: "auto" | "required";
  parallel_tool_calls: boolean;
  store: boolean;
  stream: boolean;
  include: string[];
}

export type OpenAIUpstreamRequest = OpenAIChatRequest | OpenAIResponsesRequest;
