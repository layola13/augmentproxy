import { loadCodexPromptAssets } from "./codex-assets.ts";
import { loadConfigFromEnvFile } from "./config.ts";
import {
  buildRemoteCompactPayload,
  buildSummaryMessage,
  optimizeRequestInput,
} from "./history-pruning.ts";
import {
  appendEventLog,
  appendRuntimeLog,
  createRequestLogContext,
  headersToObject,
  logLine,
  retainRecentMessages,
  writeJsonArtifact,
  writeTextArtifact,
} from "./logger.ts";
import {
  buildContextTokenPayload,
  countContextTokens,
  extractMessageItems,
} from "./token-metrics.ts";
import type {
  AutoModelConfig,
  CodexPromptAssets,
  ContextTokenMetrics,
  HistoryPruneStats,
  JsonObject,
  JsonValue,
  OptimizedInputResult,
  ParsedSseEvent,
  PromptVariantName,
  UpstreamTargetConfig,
  UpstreamTurn,
} from "./types.ts";

type RuntimeContext = {
  config: Awaited<ReturnType<typeof loadConfigFromEnvFile>>;
  assets: CodexPromptAssets;
};

type RequestRewriteResult = {
  instructions: string;
  matched: boolean;
  variant?: PromptVariantName;
  tail: string;
};

let runtimePromise: Promise<RuntimeContext> | undefined;

function serverLog(
  config: RuntimeContext["config"],
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>,
): void {
  logLine(level, message, meta);
  void appendRuntimeLog(config, level, message, meta);
}

function objectValue(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asInputList(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) return [...value];
  if (value === undefined) return [];
  return [value];
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function copyResponseHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete("content-length");
  return next;
}

function copyBufferedResponseHeaders(headers: Headers): Headers {
  const next = copyResponseHeaders(headers);
  next.delete("content-encoding");
  next.delete("transfer-encoding");
  return next;
}

function buildSseClientHeaders(headers: Headers): Headers {
  const next = new Headers();
  next.set("content-type", "text/event-stream; charset=utf-8");
  next.set("cache-control", headers.get("cache-control") ?? "no-cache");
  next.set("connection", "keep-alive");
  for (
    const name of [
      "x-request-id",
      "request-id",
      "retry-after",
      "cf-ray",
      "openai-model",
      "x-openai-model",
      "x-reasoning-included",
      "x-codex-turn-state",
      "x-codex-turn-metadata",
      "x-codex-parent-thread-id",
      "x-codex-window-id",
      "x-codex-installation-id",
    ]
  ) {
    const value = headers.get(name);
    if (value) next.set(name, value);
  }
  return next;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function newRequestId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `req_${stamp}_${crypto.randomUUID().slice(0, 8)}`;
}

function isEventStream(headers: Headers, rawBody = ""): boolean {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream") || rawLooksLikeSse(rawBody);
}

function rawLooksLikeSse(rawBody: string): boolean {
  const trimmed = rawBody.trimStart();
  return trimmed.startsWith("event:") ||
    trimmed.startsWith("data:") ||
    /\r?\ndata:/.test(rawBody) ||
    /\r?\nevent:/.test(rawBody);
}

function rawLooksLikeJson(rawBody: string): boolean {
  const trimmed = rawBody.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function resolveReturnedContentType(headers: Headers, rawBody: string): string {
  if (rawLooksLikeSse(rawBody)) return "text/event-stream; charset=utf-8";
  if (rawLooksLikeJson(rawBody)) return "application/json; charset=utf-8";
  const existing = headers.get("content-type");
  if (existing && !existing.toLowerCase().includes("text/event-stream")) return existing;
  return "text/plain; charset=utf-8";
}

function buildBufferedClientHeaders(headers: Headers, rawBody: string): Headers {
  const next = copyBufferedResponseHeaders(headers);
  next.set("content-type", resolveReturnedContentType(headers, rawBody));
  return next;
}

function contentTextParts(value: JsonValue | undefined): string[] {
  const parts: string[] = [];
  const list = Array.isArray(value) ? value : [];
  for (const item of list) {
    const record = objectValue(item);
    const type = stringValue(record.type) ?? "";
    if (
      (type === "input_text" || type === "output_text" || type === "summary_text" ||
        type === "text") &&
      typeof record.text === "string"
    ) {
      parts.push(record.text);
    }
  }
  return parts;
}

function extractMessageText(item: JsonObject): string {
  return contentTextParts(item.content).join("");
}

function summarizeTools(request: JsonObject): string[] {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  return tools.map((value) => {
    const record = objectValue(value);
    const type = stringValue(record.type) ?? "unknown";
    const name = stringValue(record.name) ?? "unknown";
    return `${type}:${name}`;
  });
}

function hasToolHistory(input: JsonValue[]): boolean {
  return input.some((item) => {
    const type = stringValue(objectValue(item).type) ?? "";
    return type === "function_call" || type === "function_call_output";
  });
}

function didMutateLocalInput(stats: HistoryPruneStats): boolean {
  return stats.inputCountAfter !== stats.inputCountBefore ||
    stats.bytesAfter !== stats.bytesBefore ||
    stats.droppedReasoningCount > 0 ||
    stats.droppedFunctionCallCount > 0 ||
    stats.droppedFunctionCallOutputCount > 0 ||
    stats.truncatedToolOutputCount > 0 ||
    stats.truncatedFunctionCallCount > 0 ||
    stats.dedupedFunctionCallCount > 0 ||
    stats.dedupedFunctionCallOutputCount > 0 ||
    stats.compactedPinnedUserCodeBlockCount > 0;
}

function extractMessageTextFromContent(content: JsonValue | undefined): string {
  return contentTextParts(content).join("\n");
}

function extractLatestUserText(input: JsonValue[]): string {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = objectValue(input[index]);
    if (stringValue(item.type) !== "message" || stringValue(item.role) !== "user") continue;
    const text = extractMessageTextFromContent(item.content).trim();
    if (text) return text;
  }
  return "";
}

function hasCodeSignals(text: string): boolean {
  return /```[\s\S]*?```/.test(text) ||
    /\b(import|export|const|let|var|function|class|interface|type|enum|struct|fn|def|async|await|return)\b/i
      .test(text) ||
    /\b(implement|fix|refactor|compile|traceback|stack trace|exception|test|bug|patch|diff)\b/i
      .test(text) ||
    /(?:^|\s)(?:\/[\w./-]+|\w+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|json|md|yaml|yml|toml|sh))/.test(text);
}

function hasDocSignals(text: string): boolean {
  return /\b(doc|docs|documentation|readme|guide|manual|reference|sdk|api reference|model card|spec|specification)\b/i
      .test(text) ||
    /(文档|说明|教程|手册|参考|接口文档|API 文档|SDK|README)/i.test(text);
}

function hasPlanSignals(text: string): boolean {
  return /\b(plan|planning|brainstorm|architecture|design|analyze|analysis|investigate|research|review)\b/i
      .test(text) ||
    /(规划|计划|方案|架构|设计|分析|调研|评审|review)/i.test(text);
}

export function chooseAutoModel(
  requestBody: JsonObject,
  autoModels: AutoModelConfig,
): { model: string; reason: string } {
  const input = asInputList(requestBody.input);
  const latestUserText = extractLatestUserText(input);
  if (hasDocSignals(latestUserText)) {
    return { model: autoModels.docModel, reason: "doc_signal" };
  }
  if (hasCodeSignals(latestUserText)) {
    return { model: autoModels.codeModel, reason: "code_signal" };
  }
  if (hasPlanSignals(latestUserText)) {
    return { model: autoModels.planModel, reason: "plan_signal" };
  }
  return { model: autoModels.defaultModel, reason: "default" };
}

export function resolveRequestedModel(
  requestBody: JsonObject,
  autoModels: AutoModelConfig,
): { model: string; source: "client" | "auto"; reason: string } {
  const requestedModel = stringValue(requestBody.model)?.trim();
  if (requestedModel && requestedModel.toLowerCase() !== "auto") {
    return { model: requestedModel, source: "client", reason: "client_model" };
  }
  const resolved = chooseAutoModel(requestBody, autoModels);
  return { model: resolved.model, source: "auto", reason: resolved.reason };
}

type ProxyAuthInspection = {
  token?: string;
  source?: "authorization" | "x-api-key" | "api-key";
  scheme?: string;
  authorizationPresent: boolean;
  xApiKeyPresent: boolean;
  apiKeyPresent: boolean;
};

function maskSecretPreview(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 10) return `${trimmed.slice(0, 2)}...${trimmed.length}`;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)} (len=${trimmed.length})`;
}

function inspectProxyAccess(headers: Headers): ProxyAuthInspection {
  const auth = headers.get("authorization")?.trim();
  const xApiKey = headers.get("x-api-key")?.trim();
  const apiKey = headers.get("api-key")?.trim();

  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return {
      token: match?.[1]?.trim() ?? auth,
      source: "authorization",
      scheme: match ? "bearer" : "raw",
      authorizationPresent: true,
      xApiKeyPresent: Boolean(xApiKey),
      apiKeyPresent: Boolean(apiKey),
    };
  }
  if (xApiKey) {
    return {
      token: xApiKey,
      source: "x-api-key",
      scheme: "header",
      authorizationPresent: false,
      xApiKeyPresent: true,
      apiKeyPresent: Boolean(apiKey),
    };
  }
  if (apiKey) {
    return {
      token: apiKey,
      source: "api-key",
      scheme: "header",
      authorizationPresent: false,
      xApiKeyPresent: false,
      apiKeyPresent: true,
    };
  }
  return {
    authorizationPresent: false,
    xApiKeyPresent: false,
    apiKeyPresent: false,
  };
}

function isAuthorizedProxyRequest(expectedApiKey: string | undefined, request: Request): boolean {
  if (!expectedApiKey) return true;
  return inspectProxyAccess(request.headers).token === expectedApiKey;
}

function computeContextTokenMetrics(
  beforeRequest: JsonObject,
  afterLocalRequest: JsonObject,
  afterFinalRequest: JsonObject,
): ContextTokenMetrics {
  const before = countContextTokens(buildContextTokenPayload(beforeRequest));
  const afterLocal = countContextTokens(buildContextTokenPayload(afterLocalRequest));
  const afterFinal = countContextTokens(buildContextTokenPayload(afterFinalRequest));
  const ratio = before > 0 ? afterFinal / before : 1;
  const percent = Number((ratio * 100).toFixed(2));
  return { before, afterLocal, afterFinal, ratio, percent };
}

function forwardHeaders(
  incoming: Headers,
  apiKey: string,
  accept: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of incoming.entries()) {
    const normalized = key.toLowerCase();
    if (
      normalized === "host" ||
      normalized === "content-length" ||
      normalized === "authorization" ||
      normalized === "connection"
    ) {
      continue;
    }
    if (normalized === "content-type" || normalized === "accept") {
      continue;
    }
    headers.set(key, value);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", accept);
  headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  requestSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("upstream timeout"), timeoutMs);
  const abortListener = () => controller.abort(requestSignal?.reason ?? "client aborted");
  requestSignal?.addEventListener("abort", abortListener, { once: true });
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abortListener);
  }
}

function parseJsonRequestBody(raw: string): JsonObject {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as JsonValue;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Responses request body must be a JSON object.");
  }
  return parsed as JsonObject;
}

function parseSseText(rawSse: string, status = 200): UpstreamTurn {
  const events: ParsedSseEvent[] = [];
  let responseId: string | undefined;
  let usage: JsonObject | undefined;

  for (const block of rawSse.split(/\r?\n\r?\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let eventType = "";
    const dataLines: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (!eventType || dataLines.length === 0) continue;
    const dataText = dataLines.join("\n");
    if (dataText === "[DONE]") continue;
    const data = objectValue(JSON.parse(dataText) as JsonValue);
    events.push({ type: eventType, data });
    const createdId = stringValue(objectValue(data.response).id) ?? stringValue(data.id);
    if (createdId) responseId = createdId;
    const responseUsage = objectValue(objectValue(data.response).usage);
    if (Object.keys(responseUsage).length > 0) usage = responseUsage;
  }

  return { events, responseId, usage, rawSse, status };
}

function buildJsonResponse(turn: UpstreamTurn): JsonObject {
  const output: JsonValue[] = [];
  let outputText = "";
  for (const event of turn.events) {
    if (event.type === "response.output_item.done") {
      const item = objectValue(event.data.item);
      output.push(item);
      if (stringValue(item.type) === "message") {
        outputText += contentTextParts(item.content).join("");
      } else if (stringValue(item.type) === "compaction") {
        outputText += stringValue(item.encrypted_content) ?? "";
      }
    }
    if (event.type === "response.output_text.delta") {
      outputText += stringValue(event.data.delta) ?? "";
    }
  }
  return {
    id: turn.responseId ?? "",
    object: "response",
    output,
    output_text: outputText,
    usage: turn.usage ?? {},
  };
}

export function extractResponseText(payload: JsonValue): string {
  const record = objectValue(payload);
  const explicit = stringValue(record.output_text);
  if (explicit) return explicit.trim();

  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const outputItem = objectValue(item);
    const type = stringValue(outputItem.type) ?? "";
    if (type === "message") {
      parts.push(extractMessageText(outputItem));
      continue;
    }
    if (type === "compaction" && typeof outputItem.encrypted_content === "string") {
      parts.push(outputItem.encrypted_content);
      continue;
    }
    if (type === "reasoning") {
      parts.push(...contentTextParts(outputItem.summary));
    }
  }
  return parts.join("\n").trim();
}

function buildCompactUserMessage(
  pinnedContext: string,
  compressibleHistory: string,
): JsonObject {
  return {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: [
        "Pinned context below is reference only. It will remain verbatim in the final request outside your summary.",
        "Summarize only the compressible history into a concise coding handoff.",
        "",
        "Pinned context:",
        pinnedContext || "<none>",
        "",
        "Compressible history:",
        compressibleHistory,
        "",
        "Return only the summary text.",
      ].join("\n"),
    }],
  };
}

function buildCompactRequest(
  model: string,
  assets: CodexPromptAssets,
  pinnedContext: string,
  compressibleHistory: string,
): JsonObject {
  return {
    model,
    instructions: assets.compactPrompt.trim(),
    input: [buildCompactUserMessage(pinnedContext, compressibleHistory)],
    tools: [],
    parallel_tool_calls: false,
    store: false,
    stream: false,
    text: {
      verbosity: "low",
    },
  };
}

function compactVariantEntries(
  assets: CodexPromptAssets,
): Array<{ variant: PromptVariantName; full: string; compact: string }> {
  return (["pragmatic", "friendly", "default"] as PromptVariantName[])
    .map((variant) => ({
      variant,
      full: normalizeLineEndings(assets.fullVariants[variant]),
      compact: normalizeLineEndings(assets.compactVariants[variant]),
    }))
    .sort((a, b) => b.full.length - a.full.length);
}

export function rewriteCodexInstructions(
  rawInstructions: string,
  assets: CodexPromptAssets,
): RequestRewriteResult {
  if (!rawInstructions) {
    return {
      instructions: rawInstructions,
      matched: false,
      tail: "",
    };
  }

  const normalizedInstructions = normalizeLineEndings(rawInstructions);
  for (const entry of compactVariantEntries(assets)) {
    if (!normalizedInstructions.startsWith(entry.full)) continue;
    const tail = normalizedInstructions.slice(entry.full.length);
    return {
      instructions: `${entry.compact}${tail}`,
      matched: true,
      variant: entry.variant,
      tail,
    };
  }

  return {
    instructions: normalizedInstructions,
    matched: false,
    tail: "",
  };
}

async function loadRuntime(): Promise<RuntimeContext> {
  runtimePromise ??= (async () => {
    const config = await loadConfigFromEnvFile();
    const assets = await loadCodexPromptAssets(config.codexRoot);
    return { config, assets };
  })();
  return await runtimePromise;
}

async function executeNonStreamRequest(
  runtime: RuntimeContext,
  target: UpstreamTargetConfig,
  requestBody: JsonObject,
  incomingHeaders: Headers,
  requestSignal: AbortSignal,
  requestId: string,
  requestDir: string,
  artifactPrefix: string,
): Promise<{ raw: string; payload: JsonObject; status: number; headers: Headers }> {
  const upstreamHeaders = forwardHeaders(
    incomingHeaders,
    target.apiKey,
    "application/json, text/event-stream",
  );
  await writeJsonArtifact(
    { requestId, requestDir },
    `${artifactPrefix}-request.json`,
    {
      url: target.url,
      method: "POST",
      headers: headersToObject(upstreamHeaders),
      body: requestBody,
    },
  );
  const upstream = await fetchWithTimeout(
    target.url,
    {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(requestBody),
    },
    runtime.config.requestTimeoutMs,
    requestSignal,
  );
  const raw = await upstream.text().catch(() => "");
  await writeTextArtifact(
    { requestId, requestDir },
    `${artifactPrefix}-response.txt`,
    raw,
  );
  await writeJsonArtifact(
    { requestId, requestDir },
    `${artifactPrefix}-response-meta.json`,
    {
      status: upstream.status,
      headers: headersToObject(upstream.headers),
    },
  );
  if (!upstream.ok) {
    throw new Error(
      `Upstream returned ${upstream.status}: ${raw.slice(0, 1200) || "<empty body>"}`,
    );
  }

  if (isEventStream(upstream.headers, raw)) {
    const turn = parseSseText(raw, upstream.status);
    return {
      raw,
      payload: buildJsonResponse(turn),
      status: upstream.status,
      headers: upstream.headers,
    };
  }

  return {
    raw,
    payload: objectValue(JSON.parse(raw) as JsonValue),
    status: upstream.status,
    headers: upstream.headers,
  };
}

async function forwardFinalResponse(
  runtime: RuntimeContext,
  target: UpstreamTargetConfig,
  requestBody: JsonObject,
  incomingHeaders: Headers,
  requestSignal: AbortSignal,
  requestId: string,
  requestDir: string,
  streamMode: boolean,
): Promise<Response> {
  const upstreamHeaders = forwardHeaders(
    incomingHeaders,
    target.apiKey,
    streamMode ? "text/event-stream" : "application/json, text/event-stream",
  );
  await writeJsonArtifact(
    { requestId, requestDir },
    "04-final-request.json",
    {
      url: target.url,
      method: "POST",
      headers: headersToObject(upstreamHeaders),
      body: requestBody,
    },
  );

  serverLog(runtime.config, "INFO", "codexproxy:upstream:request", {
    requestId,
    url: target.url,
    stream: streamMode,
    tools: summarizeTools(requestBody),
  });

  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetchWithTimeout(
      target.url,
      {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(requestBody),
      },
      runtime.config.requestTimeoutMs,
      requestSignal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    serverLog(runtime.config, "ERROR", "codexproxy:upstream:request_failed", {
      requestId,
      url: target.url,
      stream: streamMode,
      elapsedMs: Date.now() - startedAt,
      error: message,
    });
    await appendEventLog(runtime.config, {
      requestId,
      stage: "final_response_failed",
      stream: streamMode,
      elapsedMs: Date.now() - startedAt,
      error: message,
    });
    throw error;
  }

  const upstreamContentType = upstream.headers.get("content-type") ?? "";
  serverLog(runtime.config, "INFO", "codexproxy:upstream:response_headers", {
    requestId,
    status: upstream.status,
    stream: streamMode,
    contentType: upstreamContentType,
    elapsedMs: Date.now() - startedAt,
  });
  await appendEventLog(runtime.config, {
    requestId,
    stage: "final_response_headers",
    status: upstream.status,
    stream: streamMode,
    contentType: upstreamContentType,
    elapsedMs: Date.now() - startedAt,
  });

  if (streamMode && upstream.ok && upstream.body && isEventStream(upstream.headers)) {
    const [clientBody, captureBody] = upstream.body.tee();
    void (async () => {
      const raw = await new Response(captureBody).text().catch(() => "");
      await writeTextArtifact(
        { requestId, requestDir },
        "05-final-response.sse",
        raw,
      );
      await writeJsonArtifact(
        { requestId, requestDir },
        "05-final-response-meta.json",
        {
          status: upstream.status,
          headers: headersToObject(upstream.headers),
          returnedContentType: "text/event-stream; charset=utf-8",
          bytes: raw.length,
        },
      );
      serverLog(runtime.config, "INFO", "codexproxy:upstream:response_stream", {
        requestId,
        status: upstream.status,
        bytes: raw.length,
        elapsedMs: Date.now() - startedAt,
      });
      await appendEventLog(runtime.config, {
        requestId,
        stage: "final_response_stream",
        status: upstream.status,
        bytes: raw.length,
        elapsedMs: Date.now() - startedAt,
      });
    })();
    return new Response(clientBody, {
      status: upstream.status,
      headers: buildSseClientHeaders(upstream.headers),
    });
  }

  const raw = await upstream.text().catch(() => "");
  const returnedHeaders = buildBufferedClientHeaders(upstream.headers, raw);
  await writeTextArtifact(
    { requestId, requestDir },
    streamMode ? "05-final-response.txt" : "05-final-response.json",
    raw,
  );
  await writeJsonArtifact(
    { requestId, requestDir },
    "05-final-response-meta.json",
    {
      status: upstream.status,
      headers: headersToObject(upstream.headers),
      returnedContentType: returnedHeaders.get("content-type"),
      bytes: raw.length,
    },
  );
  serverLog(runtime.config, upstream.ok ? "INFO" : "WARN", "codexproxy:upstream:response_body", {
    requestId,
    status: upstream.status,
    stream: streamMode,
    contentType: upstreamContentType,
    returnedContentType: returnedHeaders.get("content-type"),
    bytes: raw.length,
    elapsedMs: Date.now() - startedAt,
  });
  await appendEventLog(runtime.config, {
    requestId,
    stage: "final_response_body",
    status: upstream.status,
    stream: streamMode,
    contentType: upstreamContentType,
    returnedContentType: returnedHeaders.get("content-type"),
    bytes: raw.length,
    elapsedMs: Date.now() - startedAt,
  });

  if (streamMode) {
    return new Response(raw, {
      status: upstream.status,
      headers: returnedHeaders,
    });
  }

  if (!upstream.ok) {
    return new Response(raw, {
      status: upstream.status,
      headers: returnedHeaders,
    });
  }

  if (isEventStream(upstream.headers, raw)) {
    return jsonResponse(buildJsonResponse(parseSseText(raw, upstream.status)), upstream.status);
  }

  return new Response(raw, {
    status: upstream.status,
    headers: returnedHeaders,
  });
}

async function handleResponsesRequest(request: Request): Promise<Response> {
  const runtime = await loadRuntime();
  const requestId = newRequestId();
  const proxyAuth = inspectProxyAccess(request.headers);

  if (!isAuthorizedProxyRequest(runtime.config.proxyApiKey, request)) {
    serverLog(runtime.config, "WARN", "codexproxy:auth:rejected", {
      requestId,
      path: new URL(request.url).pathname,
      authSource: proxyAuth.source ?? "missing",
      authScheme: proxyAuth.scheme ?? "missing",
      authorizationPresent: proxyAuth.authorizationPresent,
      xApiKeyPresent: proxyAuth.xApiKeyPresent,
      apiKeyPresent: proxyAuth.apiKeyPresent,
      providedPreview: maskSecretPreview(proxyAuth.token),
      expectedPreview: maskSecretPreview(runtime.config.proxyApiKey),
    });
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const logContext = await createRequestLogContext(runtime.config, requestId);
  const rawBody = await request.text();

  let requestBody: JsonObject;
  try {
    requestBody = parseJsonRequestBody(rawBody);
  } catch (error) {
    serverLog(runtime.config, "WARN", "codexproxy:invalid-json", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: "Invalid JSON request body." }, 400);
  }

  await writeJsonArtifact(logContext, "00-incoming-request.json", {
    method: request.method,
    url: request.url,
    headers: headersToObject(request.headers),
    body: requestBody,
  });
  serverLog(runtime.config, "INFO", "codexproxy:client:req", {
    requestId,
    stream: requestBody.stream === true,
    request: requestBody,
  });

  const originalInput = asInputList(requestBody.input);
  const inputHasToolHistory = hasToolHistory(originalInput);
  const optimizeResult = optimizeRequestInput(originalInput, {
    keepRecentUserMessages: runtime.config.keepRecentUserMessages,
    keepRecentItems: runtime.config.keepRecentItems,
    keepRecentFunctionCallPairs: runtime.config.keepRecentFunctionCallPairs,
    keepRecentReasoningItems: runtime.config.keepRecentReasoningItems,
    keepFunctionCallName: runtime.config.keepFunctionCallName,
    oldToolOutputPreviewChars: runtime.config.oldToolOutputPreviewChars,
    oldFunctionArgumentsPreviewChars: runtime.config.oldFunctionArgumentsPreviewChars,
    dropOldReasoning: runtime.config.dropOldReasoning,
  });

  const instructions = typeof requestBody.instructions === "string" ? requestBody.instructions : "";
  const rewrittenInstructions = rewriteCodexInstructions(instructions, runtime.assets);
  const streamMode = requestBody.stream === true ||
    request.headers.get("accept")?.includes("text/event-stream") === true;
  const selectedModel = resolveRequestedModel(requestBody, runtime.config.autoModels);

  await writeJsonArtifact(logContext, "01-local-optimization.json", {
    stats: optimizeResult.stats,
    instructionsMatched: rewrittenInstructions.matched,
    instructionsVariant: rewrittenInstructions.variant ?? null,
    selectedModel,
    localInput: optimizeResult.localInput,
  });
  serverLog(runtime.config, "INFO", "codexproxy:local_prune:applied", {
    requestId,
    inputItemsBefore: originalInput.length,
    inputItemsAfter: optimizeResult.localInput.length,
    keepRecentFunctionCallPairs: runtime.config.keepRecentFunctionCallPairs,
    keepRecentReasoningItems: runtime.config.keepRecentReasoningItems,
    keepFunctionCallName: runtime.config.keepFunctionCallName,
    droppedFunctionCallCount: optimizeResult.stats.droppedFunctionCallCount,
    droppedFunctionCallOutputCount: optimizeResult.stats.droppedFunctionCallOutputCount,
    droppedReasoningCount: optimizeResult.stats.droppedReasoningCount,
  });
  await appendEventLog(runtime.config, {
    requestId,
    stage: "local_prune_applied",
    inputItemsBefore: originalInput.length,
    inputItemsAfter: optimizeResult.localInput.length,
    keepRecentFunctionCallPairs: runtime.config.keepRecentFunctionCallPairs,
    keepRecentReasoningItems: runtime.config.keepRecentReasoningItems,
    keepFunctionCallName: runtime.config.keepFunctionCallName,
    droppedFunctionCallCount: optimizeResult.stats.droppedFunctionCallCount,
    droppedFunctionCallOutputCount: optimizeResult.stats.droppedFunctionCallOutputCount,
    droppedReasoningCount: optimizeResult.stats.droppedReasoningCount,
  });

  let finalInput = optimizeResult.localInput;
  const remoteCompactPayload = buildRemoteCompactPayload(optimizeResult.prefixSegments);
  const allowRemoteCompact = runtime.config.enableCompactModel && !inputHasToolHistory;
  if (remoteCompactPayload.compressibleHistory.trim() && allowRemoteCompact) {
    const liteUpstream = runtime.config.liteUpstream;
    const liteModel = runtime.config.liteModel;
    if (!liteUpstream || !liteModel) {
      throw new Error("Compact model is enabled but LITE upstream config is incomplete.");
    }
    const compactRequest = buildCompactRequest(
      liteModel,
      runtime.assets,
      remoteCompactPayload.pinnedContext,
      remoteCompactPayload.compressibleHistory,
    );
    try {
      const compactResult = await executeNonStreamRequest(
        runtime,
        liteUpstream,
        compactRequest,
        request.headers,
        request.signal,
        requestId,
        logContext.requestDir,
        "02-compact",
      );
      const summaryText = extractResponseText(compactResult.payload);
      if (summaryText) {
        finalInput = [
          ...optimizeResult.prefixSegments
            .filter((segment) => !segment.compressible)
            .map((segment) => segment.item),
          buildSummaryMessage(runtime.assets.summaryPrefix, summaryText),
          ...optimizeResult.suffixItems,
        ];
        await writeJsonArtifact(logContext, "03-compact-summary.json", {
          summaryText,
          finalInput,
        });
      }
    } catch (error) {
      serverLog(runtime.config, "WARN", "codexproxy:compact:failed-open", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      await appendEventLog(runtime.config, {
        requestId,
        stage: "compact_failed_open",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (remoteCompactPayload.compressibleHistory.trim()) {
    const reason = runtime.config.enableCompactModel
      ? "tool_history_present"
      : "ENABLE_COMPACT_MODEL=false";
    serverLog(runtime.config, "INFO", "codexproxy:compact:disabled", {
      requestId,
      reason,
      candidateBytes: remoteCompactPayload.compressibleHistory.length,
    });
    await appendEventLog(runtime.config, {
      requestId,
      stage: "compact_disabled",
      reason,
      candidateBytes: remoteCompactPayload.compressibleHistory.length,
    });
  }

  const finalRequest: JsonObject = {
    ...structuredClone(requestBody),
    model: selectedModel.model,
    instructions: rewrittenInstructions.instructions,
    input: finalInput,
  };
  if (rewrittenInstructions.instructions !== instructions || didMutateLocalInput(optimizeResult.stats)) {
    delete finalRequest.previous_response_id;
  }

  const localRequestForMetrics: JsonObject = {
    ...structuredClone(requestBody),
    model: selectedModel.model,
    instructions: rewrittenInstructions.instructions,
    input: optimizeResult.localInput,
  };
  if (rewrittenInstructions.instructions !== instructions || didMutateLocalInput(optimizeResult.stats)) {
    delete localRequestForMetrics.previous_response_id;
  }

  const tokenMetrics = computeContextTokenMetrics(
    requestBody,
    localRequestForMetrics,
    finalRequest,
  );
  await writeJsonArtifact(logContext, "01-context-metrics.json", tokenMetrics);
  serverLog(runtime.config, "INFO", "codexproxy:context:tokens", {
    requestId,
    selectedModel: selectedModel.model,
    selectedModelSource: selectedModel.source,
    selectedModelReason: selectedModel.reason,
    inputItemsBefore: originalInput.length,
    inputItemsAfter: finalInput.length,
    before: tokenMetrics.before,
    afterLocal: tokenMetrics.afterLocal,
    afterFinal: tokenMetrics.afterFinal,
    afterBeforeRatio: Number(tokenMetrics.ratio.toFixed(4)),
    afterBeforePercent: tokenMetrics.percent,
  });
  await retainRecentMessages(
    runtime.config,
    requestId,
    "final_input",
    extractMessageItems(finalInput),
  );

  await appendEventLog(runtime.config, {
    requestId,
    stage: "request_ready",
    stream: streamMode,
    model: selectedModel.model,
    model_source: selectedModel.source,
    model_reason: selectedModel.reason,
    instructionsMatched: rewrittenInstructions.matched,
    instructionsVariant: rewrittenInstructions.variant ?? null,
    tools: summarizeTools(finalRequest),
    stats: toJsonValue(optimizeResult.stats),
    context_tokens: toJsonValue(tokenMetrics),
  });

  return await forwardFinalResponse(
    runtime,
    runtime.config.codexUpstream,
    finalRequest,
    request.headers,
    request.signal,
    requestId,
    logContext.requestDir,
    streamMode,
  );
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    const runtime = await loadRuntime();
    return jsonResponse({
      ok: true,
      codexUpstreamUrl: runtime.config.codexUpstream.url,
      enableCompactModel: runtime.config.enableCompactModel,
      liteUpstreamUrl: runtime.config.liteUpstream?.url ?? null,
      liteModel: runtime.config.liteModel ?? null,
      defaultModel: runtime.config.autoModels.defaultModel,
      proxyAuthEnabled: Boolean(runtime.config.proxyApiKey),
    });
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/v1/responses" || url.pathname === "/responses")
  ) {
    try {
      return await handleResponsesRequest(request);
    } catch (error) {
      const runtime = await loadRuntime().catch(() => undefined);
      const meta = {
        error: error instanceof Error ? error.message : String(error),
      };
      if (runtime) serverLog(runtime.config, "ERROR", "codexproxy:request:failed", meta);
      else logLine("ERROR", "codexproxy:request:failed", meta);
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : "Internal proxy error.",
        },
        500,
      );
    }
  }

  if (url.pathname === "/v1/responses" || url.pathname === "/responses") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  return jsonResponse({ error: "Not found." }, 404);
}

export async function startServer(): Promise<void> {
  const runtime = await loadRuntime();
  serverLog(runtime.config, "INFO", "codexproxy:start", {
    port: runtime.config.port,
    codexUpstreamUrl: runtime.config.codexUpstream.url,
    enableCompactModel: runtime.config.enableCompactModel,
    liteUpstreamUrl: runtime.config.liteUpstream?.url ?? null,
    liteModel: runtime.config.liteModel ?? null,
    defaultModel: runtime.config.autoModels.defaultModel,
    proxyAuthEnabled: Boolean(runtime.config.proxyApiKey),
    codexRoot: runtime.config.codexRoot,
  });
  Deno.serve({ port: runtime.config.port }, handleRequest);
}

if (import.meta.main) {
  await startServer();
}
