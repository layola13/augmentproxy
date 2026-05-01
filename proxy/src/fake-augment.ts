import type { JsonObject, JsonValue, ProxyConfig, RequestContext } from "./types.ts";

interface AgentRecord {
  agent_id: string;
  agent_name: string;
  status: string;
  capabilities: JsonValue[];
  created_at: string;
  updated_at: string;
  tags: JsonValue[];
  messages: JsonObject[];
  session_config: JsonObject;
}

const agents = new Map<string, AgentRecord>();

function bodyObject(ctx: RequestContext): JsonObject {
  return ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? ctx.body : {};
}

function stringField(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function now(): string {
  return new Date().toISOString();
}

function historySummaryParams(config: ProxyConfig): string {
  return JSON.stringify({
    prompt: config.augmentHistorySummaryPrompt,
    history_tail_size_tokens_to_exclude: config.augmentHistoryTailTokens,
    max_history_chars: config.augmentHistoryMaxChars,
    input_budget_trigger_ratio: 0.95,
  });
}

function modelInfoRegistry(config: ProxyConfig): string {
  return JSON.stringify({
    [config.openaiModel]: {
      humanName: config.openaiModel,
      description: "OpenAI-compatible upstream model via augmentproxy",
      encoding: "o200k_base",
      context: config.augmentModelContextTokens,
      maxOutput: config.augmentModelMaxOutputTokens,
    },
  });
}

export function fakeToken(): JsonObject {
  return {
    access_token: "fake-augment-access-token",
    token_type: "Bearer",
    expires_in: 31536000,
    scope: "email profile offline_access",
  };
}

export function fakeModels(config: ProxyConfig): JsonObject {
  return {
    default_model: config.openaiModel,
    models: [
      {
        name: config.openaiModel,
        internal_name: config.openaiModel,
        suggested_prefix_char_count: 12000,
        suggested_suffix_char_count: 12000,
        completion_timeout_ms: 600000,
      },
    ],
    languages: [
      { name: "TypeScript", vscode_name: "typescript", extensions: [".ts", ".tsx"] },
      { name: "JavaScript", vscode_name: "javascript", extensions: [".js", ".jsx", ".mjs"] },
      { name: "Python", vscode_name: "python", extensions: [".py"] },
      { name: "Markdown", vscode_name: "markdown", extensions: [".md"] },
      { name: "JSON", vscode_name: "json", extensions: [".json"] },
    ],
    feature_flags: {
      additional_chat_models: config.openaiModel,
      agent_chat_model: config.openaiModel,
      enable_model_registry: true,
      model_info_registry: modelInfoRegistry(config),
      history_summary_min_version: "0.0.0",
      history_summary_params: historySummaryParams(config),
      beachhead_enable_sub_agent_tool: true,
      enable_hindsight: false,
      bypass_language_filter: true,
      small_sync_threshold: 1048576,
      big_sync_threshold: 10485760,
      max_upload_size_bytes: 52428800,
      cli_enable_sentry: false,
      beachhead_enable_sentry: false,
      use_intake_service_for_file_walk: false,
      cli_enable_worker_thread_path_filter: false,
    },
    user_tier: "ENTERPRISE_TIER",
    user: {
      id: config.fakeAugmentUserId,
      email: config.fakeAugmentEmail,
    },
    bootstrap_settings: {
      repository_allowlist_settings: {
        repository_urls: [],
        is_deny_list: false,
      },
    },
  };
}

export function fakeCreditInfo(): JsonObject {
  return {
    credits: {
      remaining: 999999,
      used: 0,
      limit: 999999,
    },
    subscription: {
      status: "active",
      tier: "enterprise",
    },
  };
}

export function fakeBillingSummary(): JsonObject {
  return {
    billing_summary: {
      status: "active",
      plan: "enterprise",
      usage: 0,
      limit: 999999,
    },
  };
}

export function fakeContextList(): JsonObject {
  return {
    canvases: [],
    context_canvases: [],
    next_page_token: "",
  };
}

export function fakeSettings(path: string): JsonObject {
  if (path.includes("tool-permissions")) return { permissions: [], allowed: true };
  if (path.includes("mcp")) return { configs: [], servers: [], settings: {}, tools: [] };
  return { settings: {}, configs: [] };
}

export function fakeSecrets(path: string): JsonObject {
  if (path.endsWith("/list")) return { secrets: [] };
  if (path.endsWith("/get")) return { secret: null, found: false };
  return { ok: true };
}

function serializeAgent(agent: AgentRecord): JsonObject {
  return {
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    status: agent.status,
    capabilities: agent.capabilities,
    created_at: agent.created_at,
    updated_at: agent.updated_at,
    tags: agent.tags,
    session_config: agent.session_config,
  };
}

export function fakeCloudAgent(ctx: RequestContext): JsonObject {
  const body = bodyObject(ctx);
  const timestamp = now();

  if (ctx.path.endsWith("/create")) {
    const id = `agent_${crypto.randomUUID()}`;
    const agent: AgentRecord = {
      agent_id: id,
      agent_name: stringField(body.agent_name, "Local Proxy Agent"),
      status: "ACTIVE",
      capabilities: [],
      created_at: timestamp,
      updated_at: timestamp,
      tags: [],
      messages: [],
      session_config: {},
    };
    agents.set(id, agent);
    return { agent: serializeAgent(agent) };
  }

  if (ctx.path.endsWith("/send-message")) {
    const id = stringField(body.agent_id, "default");
    const agent = agents.get(id) ?? {
      agent_id: id,
      agent_name: "Local Proxy Agent",
      status: "ACTIVE",
      capabilities: [],
      created_at: timestamp,
      updated_at: timestamp,
      tags: [],
      messages: [],
      session_config: {},
    };
    agent.messages.push({
      id: `msg_${crypto.randomUUID()}`,
      role: "user",
      content: [{ type: "text", text: stringField(body.message, "") }],
      created_at: timestamp,
    });
    agent.updated_at = timestamp;
    agents.set(id, agent);
    return { ok: true, agent: serializeAgent(agent) };
  }

  if (ctx.path.endsWith("/get-messages")) {
    const id = stringField(body.agent_id, "default");
    return { messages: agents.get(id)?.messages ?? [] };
  }

  if (ctx.path.endsWith("/list")) {
    return { agents: [...agents.values()].map(serializeAgent), next_page_token: "" };
  }

  if (ctx.path.endsWith("/delete")) {
    agents.delete(stringField(body.agent_id, ""));
    return { ok: true };
  }

  if (ctx.path.endsWith("/rename")) {
    const id = stringField(body.agent_id, "");
    const agent = agents.get(id);
    if (agent) {
      agent.agent_name = stringField(body.new_name, agent.agent_name);
      agent.updated_at = timestamp;
      return { agent: serializeAgent(agent) };
    }
    return { ok: true };
  }

  if (ctx.path.endsWith("/update-session-config")) {
    const id = stringField(body.agent_id, "");
    const agent = agents.get(id);
    if (agent) {
      agent.session_config = body.session_config && typeof body.session_config === "object" && !Array.isArray(body.session_config)
        ? body.session_config
        : {};
      agent.updated_at = timestamp;
      return { agent: serializeAgent(agent) };
    }
    return { ok: true };
  }

  if (ctx.path.endsWith("/update-tags")) {
    const id = stringField(body.agent_id, "");
    const agent = agents.get(id);
    if (agent) {
      agent.tags = Array.isArray(body.tags) ? body.tags : [];
      agent.updated_at = timestamp;
      return { agent: serializeAgent(agent) };
    }
    return { ok: true };
  }

  if (ctx.path.endsWith("/batch-get-message-counts")) {
    const ids = Array.isArray(body.agent_ids) ? body.agent_ids : [];
    return {
      message_counts: ids.map((id) => ({
        agent_id: String(id),
        message_count: agents.get(String(id))?.messages.length ?? 0,
      })),
    };
  }

  return { ok: true };
}

export function fakeRemoteAgent(ctx: RequestContext): JsonObject {
  if (ctx.path.endsWith("/list") || ctx.path.endsWith("/list-stream")) return { agents: [], remote_agents: [] };
  if (ctx.path.endsWith("/get-chat-history") || ctx.path.endsWith("/agent-history-stream")) return { chat_history: [], messages: [] };
  return { ok: true };
}

export function fakeWorkspace(path: string): JsonObject {
  if (path.endsWith("poll-update") || path.endsWith("stream")) return { updates: [], events: [] };
  if (path.endsWith("get-last-seq-id")) return { last_seq_id: 0 };
  return { ok: true };
}


export function fakeFindMissing(ctx: RequestContext): JsonObject {
  const body = bodyObject(ctx);
  const names = Array.isArray(body.mem_object_names)
    ? body.mem_object_names.filter((name): name is string => typeof name === "string")
    : [];
  const mode = Deno.env.get("AUGMENT_INDEXING_MODE")?.trim().toLowerCase() || "capture";
  return {
    unknown_memory_names: mode === "complete" ? [] : names,
    nonindexed_blob_names: [],
  };
}

export function fakeBatchUpload(ctx: RequestContext): JsonObject {
  const body = bodyObject(ctx);
  const blobs = Array.isArray(body.blobs) ? body.blobs : [];
  const blobNames = blobs
    .map((blob) => blob && typeof blob === "object" && !Array.isArray(blob) ? (blob as JsonObject).blob_name : undefined)
    .filter((name): name is string => typeof name === "string");
  return { blob_names: blobNames };
}

export function fakeCheckpointBlobs(): JsonObject {
  return { new_checkpoint_id: `checkpoint_${crypto.randomUUID()}` };
}

export function fakeGeneric(path: string): JsonObject {
  if (path === "chat/exchanges/list") return { chat_history: [] };
  if (path.includes("indexed-commits/get-latest-blobset")) return { blobset: null, commit: null };
  if (path.includes("indexed-commits/register-blobset")) return { ok: true };
  if (path.endsWith("feedback") || path.includes("feedback")) return { ok: true };
  if (path === "record-user-events" || path === "client-metrics") return { ok: true };
  return { ok: true };
}
