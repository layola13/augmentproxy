export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface UpstreamTargetConfig {
  url: string;
  apiKey: string;
}

export interface AutoModelConfig {
  defaultModel: string;
  codeModel: string;
  planModel: string;
  docModel: string;
}

export interface CodexProxyConfig {
  port: number;
  codexUpstream: UpstreamTargetConfig;
  enableCompactModel: boolean;
  liteUpstream?: UpstreamTargetConfig;
  liteModel?: string;
  autoModels: AutoModelConfig;
  proxyApiKey?: string;
  codexRoot: string;
  logDir: string;
  heartbeatMs: number;
  requestTimeoutMs: number;
  localPruneMinTokens: number;
  keepRecentUserMessages: number;
  keepRecentItems: number;
  keepRecentFunctionCallPairs: number;
  keepRecentReasoningItems: number;
  keepFunctionCallName: boolean;
  oldToolOutputPreviewChars: number;
  oldFunctionArgumentsPreviewChars: number;
  dropOldReasoning: boolean;
}

export interface RequestLogContext {
  requestId: string;
  requestDir: string;
}

export type ParsedSseEvent = {
  type: string;
  data: JsonObject;
};

export type UpstreamTurn = {
  events: ParsedSseEvent[];
  responseId?: string;
  usage?: JsonObject;
  rawSse: string;
  status: number;
};

export type PromptVariantName = "default" | "pragmatic" | "friendly";

export interface PromptVariantSet {
  default: string;
  pragmatic: string;
  friendly: string;
}

export interface CodexPromptAssets {
  codexRoot: string;
  fullVariants: PromptVariantSet;
  compactVariants: PromptVariantSet;
  compactPrompt: string;
  summaryPrefix: string;
}

export interface HistoryPruneOptions {
  keepRecentUserMessages: number;
  keepRecentItems: number;
  keepRecentFunctionCallPairs: number;
  keepRecentReasoningItems: number;
  keepFunctionCallName: boolean;
  oldToolOutputPreviewChars: number;
  oldFunctionArgumentsPreviewChars: number;
  dropOldReasoning: boolean;
}

export interface HistoryPruneStats {
  inputCountBefore: number;
  inputCountAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  preservedFromIndex: number;
  droppedReasoningCount: number;
  droppedFunctionCallCount: number;
  droppedFunctionCallOutputCount: number;
  truncatedToolOutputCount: number;
  truncatedFunctionCallCount: number;
  dedupedFunctionCallCount: number;
  dedupedFunctionCallOutputCount: number;
  compactedPinnedUserCodeBlockCount: number;
  remoteCompactCandidateCount: number;
  remoteCompactCandidateBytes: number;
}

export interface PrefixSegment {
  item: JsonValue;
  compressible: boolean;
}

export interface OptimizedInputResult {
  localInput: JsonValue[];
  prefixSegments: PrefixSegment[];
  suffixItems: JsonValue[];
  stats: HistoryPruneStats;
  remoteSummaryInsertIndex: number | null;
  remoteSummaryHasLocalFallback: boolean;
}

export interface ContextTokenMetrics {
  before: number;
  afterLocal: number;
  afterFinal: number;
  ratio: number;
  percent: number;
}

export interface RetainedMessageRecord {
  ts: string;
  requestId: string;
  stage: string;
  index: number;
  role?: string;
  item: JsonValue;
}
