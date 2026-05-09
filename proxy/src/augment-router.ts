import type { JsonObject, ProxyConfig, RequestContext } from "./types.ts";
import { jsonResponse, ndjsonResponse, textResponse } from "./http.ts";
import {
  agentUsageStatsMarkdown,
  ensureFakeAgent,
  fakeBillingSummary,
  fakeCloudAgent,
  fakeContextList,
  fakeCreditInfo,
  fakeGeneric,
  fakeGetLatestBlobset,
  fakeModels,
  fakeRegisterBlobset,
  fakeRemoteAgent,
  fakeSecrets,
  fakeSettings,
  fakeToken,
  fakeWorkspace,
  getAgentUsageStats,
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
import { logInfo } from "./logger.ts";

function normalized(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

function bodyObject(ctx: RequestContext): Record<string, unknown> {
  return ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)
    ? ctx.body as Record<string, unknown>
    : {};
}

function jsonField<T>(value: unknown, fallback: T): T {
  return value === undefined ? fallback : value as T;
}

function remoteToolCatalog(): Array<{
  tool_id: number;
  tool_name: string;
  description: string;
  input_schema: Record<string, unknown>;
  tool_safety: number;
}> {
  const tool = (
    tool_id: number,
    tool_name: string,
    description: string,
    input_schema: Record<string, unknown>,
    tool_safety = 1,
  ) => ({
    tool_id,
    tool_name,
    description,
    input_schema,
    tool_safety,
  });
  return [
    tool(0, "unknown", "Unknown tool", { type: "object", properties: {} }, 0),
    tool(1, "web-search", "Search the web", {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    }, 1),
    tool(8, "github-api", "GitHub API access", {
      type: "object",
      properties: {},
    }, 1),
    tool(12, "linear", "Linear issue tracker", {
      type: "object",
      properties: {},
    }, 1),
    tool(13, "jira", "Jira issue tracker", {
      type: "object",
      properties: {},
    }, 1),
    tool(14, "confluence", "Confluence docs", {
      type: "object",
      properties: {},
    }, 1),
    tool(15, "notion", "Notion docs", {
      type: "object",
      properties: {},
    }, 1),
    tool(16, "supabase", "Supabase access", {
      type: "object",
      properties: {},
    }, 1),
    tool(17, "glean", "Glean search", {
      type: "object",
      properties: {},
    }, 1),
    tool(18, "github-app-readonly-api", "GitHub App readonly API", {
      type: "object",
      properties: {},
    }, 1),
    tool(19, "github-app-post-comment", "GitHub App post comment", {
      type: "object",
      properties: {},
    }, 1),
    tool(20, "github-app-pr-description", "GitHub App PR description", {
      type: "object",
      properties: {},
    }, 1),
    tool(21, "context-canvas", "Context canvas", {
      type: "object",
      properties: {},
    }, 1),
    tool(26, "spawn-agent", "Spawn a remote agent", {
      type: "object",
      properties: {
        information_request: { type: "string" },
        workspace_folder: { type: "string" },
        agent_definition: { type: "string" },
      },
      additionalProperties: true,
    }, 2),
  ];
}

function remoteToolSafety(
  toolId: number,
): { is_safe: boolean; reason: string } {
  return toolId === 26
    ? { is_safe: true, reason: "spawn-agent is allowed in the local proxy" }
    : { is_safe: true, reason: "allowed" };
}

function remoteToolAvailability(_toolId: number): number {
  // `1` means immediately available/configured in the current client build.
  return 1;
}

function parseAgentDefinition(raw: unknown): JsonObject {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as JsonObject;
  }
  if (typeof raw !== "string") return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as JsonObject
      : {};
  } catch {
    return {};
  }
}

function inferSpawnAgentMode(
  informationRequest: string,
  agentDefinition: JsonObject,
): "explore" | "plan" | "code" | "validate" | "judge" | "askexpert" | "docs" {
  const haystack = [
    informationRequest,
    typeof agentDefinition.name === "string" ? agentDefinition.name : "",
    typeof agentDefinition.description === "string"
      ? agentDefinition.description
      : "",
    typeof agentDefinition.instructions === "string"
      ? agentDefinition.instructions
      : "",
  ].join("\n").toLowerCase();
  const has = (...signals: string[]) =>
    signals.some((signal) => haystack.includes(signal));
  if (
    has(
      "askexpert",
      "ask expert",
      "expert",
      "expert diagnostic",
      "expert review",
      "consult expert",
    )
  ) {
    return "askexpert";
  }
  if (
    has(
      "docs",
      "documentation",
      "document",
      "wiki",
      "readme",
      "markdown",
      ".md",
      "system wiki",
      "write docs",
      "write documentation",
    )
  ) {
    return "docs";
  }
  if (
    has(
      "judge",
      "completion judge",
      "judge completion",
      "task complete",
      "verdict",
    )
  ) {
    return "judge";
  }
  if (
    has(
      "validate",
      "verify",
      "verification",
      "compile",
      "test ",
      "run tests",
      "terminal",
    )
  ) {
    return "validate";
  }
  if (
    has(
      "implement",
      "implementation",
      "edit file",
      "create file",
      "write code",
      "save-file",
      "refactor",
    )
  ) {
    return "code";
  }
  if (has("plan", "planning", "decompose", "break down")) {
    return "plan";
  }
  return "explore";
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

  if (path === "record-request-events" || path === "record-session-events") {
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

  if (path === "indexed-commits/get-latest-blobset") {
    await recordRequest(config, ctx, "mock-indexed-commits-latest-recorded");
    return ndjsonResponse(fakeGetLatestBlobset(ctx));
  }

  if (path === "indexed-commits/register-blobset") {
    await recordRequest(config, ctx, "mock-indexed-commits-register-recorded");
    return jsonResponse(fakeRegisterBlobset(ctx));
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
    const body = bodyObject(ctx);
    const toolIdList =
      body.tool_id_list && typeof body.tool_id_list === "object" &&
        !Array.isArray(body.tool_id_list)
        ? body.tool_id_list as Record<string, unknown>
        : {};
    const requestedIds = Array.isArray(toolIdList.tool_ids)
      ? toolIdList.tool_ids.filter((id): id is number => typeof id === "number")
      : [];
    const requestedTools = requestedIds
      .map((toolId) =>
        remoteToolCatalog().find((tool) => tool.tool_id === toolId)
      )
      .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
    await recordRequest(config, ctx, "mock-list-remote-tools-recorded");
    return jsonResponse({
      tools: requestedTools.map((tool) => ({
        remote_tool_id: tool.tool_id,
        availability_status: remoteToolAvailability(tool.tool_id),
        tool_safety: tool.tool_safety,
        oauth_url: "",
        tool_definition: {
          name: tool.tool_name,
          description: tool.description,
          input_schema_json: JSON.stringify(tool.input_schema),
          tool_safety: tool.tool_safety,
        },
        tool_id: tool.tool_id,
        tool_name: tool.tool_name,
        description: tool.description,
        input_schema: tool.input_schema,
      })),
    });
  }

  if (path === "agents/check-tool-safety") {
    const body = bodyObject(ctx);
    const toolId = typeof body.tool_id === "number" ? body.tool_id : -1;
    await recordRequest(config, ctx, "mock-check-tool-safety-recorded");
    return jsonResponse({ tool_id: toolId, ...remoteToolSafety(toolId) });
  }

  if (path === "agents/run-remote-tool") {
    const body = bodyObject(ctx);
    const toolId = typeof body.tool_id === "number" ? body.tool_id : -1;
    const toolName = typeof body.tool_name === "string" ? body.tool_name : "";
    const toolInputJson = typeof body.tool_input_json === "string"
      ? body.tool_input_json
      : JSON.stringify(jsonField(body.tool_input_json, {}));
    await recordRequest(config, ctx, "mock-run-remote-tool-recorded");
    if (toolId === 26 || toolName === "spawn-agent") {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(toolInputJson) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const informationRequest = typeof parsed.information_request === "string"
        ? parsed.information_request
        : "";
      const workspaceFolder = typeof parsed.workspace_folder === "string"
        ? parsed.workspace_folder
        : "";
      const agentDefinition = parseAgentDefinition(parsed.agent_definition);
      const mode = inferSpawnAgentMode(informationRequest, agentDefinition);
      const agent = ensureFakeAgent({
        agent_name: typeof agentDefinition.name === "string"
          ? agentDefinition.name
          : "Local Proxy Agent",
        capabilities: [{
          tool_id: 26,
          tool_name: "spawn-agent",
          workspace_folder: workspaceFolder,
          mode,
        }],
        session_config: {
          mode,
          information_request: informationRequest,
          workspace_folder: workspaceFolder,
          agent_definition: agentDefinition,
        },
      });
      const toolOutput = {
        agent_id: agent.agent_id,
        tool_input_json: toolInputJson,
        workspace_folder: (() => {
          return typeof parsed.workspace_folder === "string"
            ? parsed.workspace_folder
            : "";
        })(),
      };
      const resultMessage = `Spawned agent ${agent.agent_id} in mode ${mode}` +
        (workspaceFolder ? ` for ${workspaceFolder}` : "");
      return jsonResponse({
        status: 1,
        status_text: "success",
        tool_id: 26,
        tool_name: "spawn-agent",
        tool_output: toolOutput,
        tool_result_message: resultMessage,
      });
    }
    return jsonResponse({
      status: 1,
      status_text: "success",
      tool_id: toolId,
      tool_name: toolName,
      tool_output: {
        tool_input_json: toolInputJson,
      },
      tool_result_message: `Remote tool ${
        toolName || toolId
      } executed successfully`,
    });
  }

  if (path === "agents/usage-stats") {
    return jsonResponse(getAgentUsageStats());
  }

  if (path === "agents/usage-stats.md") {
    return textResponse(agentUsageStatsMarkdown(), 200, {
      "content-type": "text/markdown; charset=utf-8",
    });
  }

  if (path === "agents/codebase-retrieval") {
    const body = bodyObject(ctx);
    logInfo(config, "agents:codebase-retrieval:call", {
      requestId: ctx.requestId,
      query: body.information_request,
      folder: body.workspace_folder,
    });
    const result = await handleCodebaseRetrieval(config, ctx);
    logInfo(config, "agents:codebase-retrieval:result", {
      requestId: ctx.requestId,
      chars: (result as any).formattedRetrieval?.length ?? 0,
    });
    return jsonResponse(result);
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
