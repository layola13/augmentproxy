import type { ProxyConfig, RequestContext } from "./types.ts";
import { jsonResponse, textResponse } from "./http.ts";
import {
  fakeBatchUpload,
  fakeBillingSummary,
  fakeCheckpointBlobs,
  fakeCloudAgent,
  fakeContextList,
  fakeCreditInfo,
  fakeFindMissing,
  fakeGeneric,
  fakeModels,
  fakeRemoteAgent,
  fakeSecrets,
  fakeSettings,
  fakeToken,
  fakeWorkspace,
} from "./fake-augment.ts";
import { handleCodebaseRetrieval } from "./codebase-retrieval.ts";
import { recordRequest } from "./request-recorder.ts";
import {
  forwardAugmentJson,
  forwardAugmentStream,
  forwardCompletion,
} from "./openai-adapter.ts";
import {
  indexBatchUpload,
  indexCheckpoint,
  indexFindMissing,
} from "./indexer.ts";

function normalized(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

function isStreamChat(path: string): boolean {
  return path === "chat-stream" || path === "prompt-enhancer";
}

function isJsonChat(path: string): boolean {
  return path === "chat" || path === "remote-agents/chat";
}

function isCompletion(path: string): boolean {
  return path === "completion" || path === "completion/request" ||
    path === "completion/complete" || path === "chat-input-completion";
}

function shouldRecord(path: string): boolean {
  return path.startsWith("context-canvas/") ||
    path.startsWith("agent-workspace/") ||
    path.startsWith("remote-agents/") ||
    path.startsWith("cloud-agents/") ||
    path.startsWith("settings/") ||
    path.startsWith("tenant-secrets/") ||
    path.startsWith("user-secrets/") ||
    path === "checkpoint-blobs" ||
    path === "batch-upload" ||
    path === "report-error" ||
    path === "find-missing" ||
    path.startsWith("indexed-commits/");
}

export async function routeAugment(
  config: ProxyConfig,
  ctx: RequestContext,
): Promise<Response> {
  const path = normalized(ctx.path);

  if (ctx.method === "GET" && (path === "" || path === "health")) {
    return jsonResponse({ ok: true, service: "augment-intercept-proxy" });
  }

  if (path === "token" || path === "auth/token" || path.endsWith("/token")) {
    return jsonResponse(fakeToken());
  }

  if (path === "get-models" || path === "models" || path === "model-config") {
    return jsonResponse(fakeModels(config));
  }

  if (path === "get-credit-info") return jsonResponse(fakeCreditInfo());
  if (path === "get-billing-summary") return jsonResponse(fakeBillingSummary());

  if (isStreamChat(path)) {
    await recordRequest(config, ctx, "openai-stream-forward");
    return await forwardAugmentStream(config, ctx);
  }

  if (isJsonChat(path)) {
    await recordRequest(config, ctx, "openai-json-forward");
    return await forwardAugmentJson(config, ctx);
  }

  if (isCompletion(path)) {
    await recordRequest(config, ctx, "openai-completion-forward");
    return await forwardCompletion(config, ctx);
  }

  if (
    path === "completion/resolve" || path === "completion/cancel" ||
    path === "resolve-completions"
  ) {
    return jsonResponse({ ok: true });
  }

  if (path === "find-missing") {
    await recordRequest(config, ctx, "mock-find-missing-capture-recorded");
    return jsonResponse(await indexFindMissing(config, ctx));
  }

  if (path === "batch-upload") {
    await recordRequest(config, ctx, "mock-batch-upload-recorded");
    return jsonResponse(await indexBatchUpload(config, ctx));
  }

  if (path === "checkpoint-blobs") {
    await recordRequest(config, ctx, "mock-checkpoint-blobs-recorded");
    return jsonResponse(await indexCheckpoint(config, ctx));
  }

  if (path === "context-canvas/list") {
    await recordRequest(config, ctx, "mock-context-recorded");
    return jsonResponse(fakeContextList());
  }

  if (path.startsWith("settings/")) {
    await recordRequest(config, ctx, "mock-settings-recorded");
    return jsonResponse(fakeSettings(path));
  }

  if (path.startsWith("tenant-secrets/") || path.startsWith("user-secrets/")) {
    await recordRequest(config, ctx, "mock-secrets-recorded");
    return jsonResponse(fakeSecrets(path));
  }

  if (path.startsWith("cloud-agents/")) {
    await recordRequest(config, ctx, "mock-cloud-agent-recorded");
    return jsonResponse(fakeCloudAgent(ctx));
  }

  if (path.startsWith("remote-agents/")) {
    await recordRequest(config, ctx, "mock-remote-agent-recorded");
    return jsonResponse(fakeRemoteAgent(ctx));
  }

  if (path.startsWith("agent-workspace/")) {
    await recordRequest(config, ctx, "mock-agent-workspace-recorded");
    return jsonResponse(fakeWorkspace(path));
  }

  if (path === "agents/list-remote-tools") {
    await recordRequest(config, ctx, "mock-list-remote-tools-recorded");
    return jsonResponse({ tools: [] });
  }

  if (path === "agents/check-tool-safety") {
    await recordRequest(config, ctx, "mock-check-tool-safety-recorded");
    return jsonResponse({ is_safe: true });
  }

  if (path === "agents/codebase-retrieval") {
    await recordRequest(config, ctx, "codebase-retrieval-recorded");
    return jsonResponse(await handleCodebaseRetrieval(config, ctx));
  }

  if (
    path === "record-user-events" || path === "client-metrics" ||
    path.includes("feedback")
  ) {
    return jsonResponse({ ok: true });
  }

  if (shouldRecord(path)) {
    await recordRequest(config, ctx, "mock-generic-recorded");
    return jsonResponse(fakeGeneric(path));
  }

  if (ctx.method === "OPTIONS") return textResponse("", 204);

  await recordRequest(config, ctx, "unknown-fallback-recorded");
  return jsonResponse(fakeGeneric(path));
}
