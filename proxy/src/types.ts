export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ProxyConfig {
  port: number;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  fakeAugmentEmail: string;
  fakeAugmentUserId: string;
  requestLogDir: string;
  userAgent: string;
  indexingMode: string;
  embedBaseUrl: string;
  embedApiKey: string;
  embedModel: string;
  embedDimensions: number;
  qdrantUrl: string;
  qdrantCollection: string;
  indexChunkChars: number;
  indexChunkOverlap: number;
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
  tool_choice?: "auto";
}
