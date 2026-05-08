import type {
  AgentUsage,
  AgentUsageSummary,
  JsonObject,
  JsonValue,
  ProxyConfig,
  RequestContext,
} from "./types.ts";

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
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

interface IndexedCommitBlobsetRecord {
  commit: JsonObject;
  blobset: JsonObject;
}

const agents = new Map<string, AgentRecord>();
const indexedCommitBlobsets = new Map<string, IndexedCommitBlobsetRecord>();
let indexedCommitBlobsetsLoadedFrom: string | undefined;

function envValue(name: string): string {
  try {
    return Deno.env.get(name)?.trim() ?? "";
  } catch {
    return "";
  }
}

function trimPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function joinFsPath(...parts: string[]): string {
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  const normalized = parts
    .filter((part) => part.length > 0)
    .map((part, index) =>
      index === 0
        ? trimPathSeparators(part)
        : part.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "")
    );
  return normalized.join(separator);
}

function parentDir(path: string): string | undefined {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : undefined;
}

function indexedCommitBlobsetCachePath(): string | undefined {
  const explicit = envValue("AUGMENT_INDEXED_COMMITS_CACHE");
  if (explicit) return explicit;

  const xdgCacheHome = envValue("XDG_CACHE_HOME");
  if (xdgCacheHome) {
    return joinFsPath(
      xdgCacheHome,
      "augmentproxy",
      "indexed-commits.json",
    );
  }

  const localAppData = envValue("LOCALAPPDATA");
  if (localAppData) {
    return joinFsPath(
      localAppData,
      "augmentproxy",
      "indexed-commits.json",
    );
  }

  const home = envValue("HOME");
  if (home) {
    return joinFsPath(
      home,
      ".cache",
      "augmentproxy",
      "indexed-commits.json",
    );
  }

  const userProfile = envValue("USERPROFILE");
  if (userProfile) {
    return joinFsPath(
      userProfile,
      "AppData",
      "Local",
      "augmentproxy",
      "indexed-commits.json",
    );
  }

  const homeDrive = envValue("HOMEDRIVE");
  const homePath = envValue("HOMEPATH");
  if (homeDrive && homePath) {
    return joinFsPath(
      `${homeDrive}${homePath}`,
      "AppData",
      "Local",
      "augmentproxy",
      "indexed-commits.json",
    );
  }

  return undefined;
}

function jsonObjectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function loadIndexedCommitBlobsets(): void {
  const cachePath = indexedCommitBlobsetCachePath();
  if (indexedCommitBlobsetsLoadedFrom === cachePath) return;

  indexedCommitBlobsets.clear();
  indexedCommitBlobsetsLoadedFrom = cachePath;
  if (!cachePath) return;

  try {
    const parsed = JSON.parse(Deno.readTextFileSync(cachePath));
    const root = jsonObjectValue(parsed);
    const entries = jsonObjectValue(root?.entries);
    if (!entries) return;

    for (const value of Object.values(entries)) {
      const record = jsonObjectValue(value);
      const commit = jsonObjectValue(record?.commit);
      const blobset = jsonObjectValue(record?.blobset);
      const commitSha = typeof commit?.commit_sha === "string"
        ? commit.commit_sha
        : "";
      if (commit && commitSha && blobset) {
        indexedCommitBlobsets.set(commitSha, {
          commit: cloneJsonObject(commit),
          blobset: cloneJsonObject(blobset),
        });
      }
    }
  } catch {
    // Missing or malformed cache files should not block Augment startup.
  }
}

function saveIndexedCommitBlobsets(): void {
  const cachePath = indexedCommitBlobsetsLoadedFrom ??
    indexedCommitBlobsetCachePath();
  if (!cachePath) return;

  const entries: JsonObject = {};
  for (const [commitSha, record] of indexedCommitBlobsets.entries()) {
    entries[commitSha] = {
      commit: record.commit,
      blobset: record.blobset,
    };
  }

  try {
    const directory = parentDir(cachePath);
    if (directory) Deno.mkdirSync(directory, { recursive: true });
    Deno.writeTextFileSync(
      cachePath,
      `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
    );
  } catch {
    // The in-memory cache still avoids repeated indexing while this process runs.
  }
}

export function resetIndexedCommitBlobsetsForTest(): void {
  indexedCommitBlobsets.clear();
  indexedCommitBlobsetsLoadedFrom = undefined;
}

export function reportAgentUsage(
  agentId: string,
  inputTokens: number,
  outputTokens: number,
  agentName?: string,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0,
): void {
  const normalizedInput = Math.max(0, inputTokens);
  const normalizedOutput = Math.max(0, outputTokens);
  const normalizedCacheRead = Math.max(0, cacheReadInputTokens);
  const normalizedCacheCreation = Math.max(0, cacheCreationInputTokens);
  if (
    !agentId ||
    (normalizedInput <= 0 && normalizedOutput <= 0 &&
      normalizedCacheRead <= 0 && normalizedCacheCreation <= 0)
  ) return;
  const existing = agents.get(agentId);
  const agent = existing ?? ensureFakeAgent({
    agent_id: agentId,
    agent_name: agentName || agentId,
  });
  if (!existing && agentName) agent.agent_name = agentName;
  agent.input_tokens += normalizedInput;
  agent.cache_read_input_tokens += normalizedCacheRead;
  agent.cache_creation_input_tokens += normalizedCacheCreation;
  agent.output_tokens += normalizedOutput;
  agent.updated_at = now();
  agents.set(agent.agent_id, agent);
}

function usageAgentName(body: JsonObject, fallback: string): string {
  if (typeof body.agent_name === "string" && body.agent_name) {
    return body.agent_name;
  }
  if (typeof body.mode === "string" && body.mode) {
    return `sub-agent:${body.mode}`;
  }
  const guidelines = typeof body.user_guidelines === "string"
    ? body.user_guidelines.toLowerCase()
    : "";
  if (guidelines.includes("documentation sub-agent")) return "sub-agent:docs";
  if (guidelines.includes("code implementation sub-agent")) {
    return "sub-agent:code";
  }
  if (guidelines.includes("validation sub-agent")) return "sub-agent:validate";
  if (guidelines.includes("task-completion judge")) return "sub-agent:judge";
  if (guidelines.includes("expert diagnostic sub-agent")) {
    return "sub-agent:askexpert";
  }
  if (guidelines.includes("sub-agent prompt")) return "sub-agent";
  return fallback;
}

export function reportAgentUsageForBody(
  body: JsonObject,
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0,
): void {
  const directAgentId = typeof body.agent_id === "string" && body.agent_id
    ? body.agent_id
    : undefined;
  if (directAgentId) {
    reportAgentUsage(
      directAgentId,
      inputTokens,
      outputTokens,
      usageAgentName(body, directAgentId),
      cacheReadInputTokens,
      cacheCreationInputTokens,
    );
    return;
  }

  const conversationId =
    typeof body.conversation_id === "string" && body.conversation_id
      ? body.conversation_id
      : undefined;
  const parentConversationId =
    typeof body.parent_conversation_id === "string" &&
      body.parent_conversation_id
      ? body.parent_conversation_id
      : undefined;
  const rootConversationId =
    typeof body.root_conversation_id === "string" && body.root_conversation_id
      ? body.root_conversation_id
      : undefined;
  const guidelines = typeof body.user_guidelines === "string"
    ? body.user_guidelines
    : "";
  const looksLikeSubAgent = Boolean(
    conversationId &&
      ((parentConversationId && parentConversationId !== conversationId) ||
        (rootConversationId && rootConversationId !== conversationId) ||
        guidelines.includes("# Sub-Agent Prompt")),
  );
  if (!looksLikeSubAgent || !conversationId) return;
  reportAgentUsage(
    conversationId,
    inputTokens,
    outputTokens,
    usageAgentName(body, conversationId),
    cacheReadInputTokens,
    cacheCreationInputTokens,
  );
}

export function getAgentUsageStats(): AgentUsageSummary {
  const agentList: AgentUsage[] = [];
  let totalInput = 0;
  let totalCacheReadInput = 0;
  let totalCacheCreationInput = 0;
  let totalOutput = 0;

  for (const agent of agents.values()) {
    if (
      agent.input_tokens > 0 ||
      agent.cache_read_input_tokens > 0 ||
      agent.cache_creation_input_tokens > 0 ||
      agent.output_tokens > 0
    ) {
      const totalInputTokens = agent.input_tokens +
        agent.cache_read_input_tokens + agent.cache_creation_input_tokens;
      const total = totalInputTokens + agent.output_tokens;
      agentList.push({
        agent_id: agent.agent_id,
        name: agent.agent_name,
        input_tokens: agent.input_tokens,
        cache_read_input_tokens: agent.cache_read_input_tokens,
        cache_creation_input_tokens: agent.cache_creation_input_tokens,
        total_input_tokens: totalInputTokens,
        output_tokens: agent.output_tokens,
        total_tokens: total,
      });
      totalInput += agent.input_tokens;
      totalCacheReadInput += agent.cache_read_input_tokens;
      totalCacheCreationInput += agent.cache_creation_input_tokens;
      totalOutput += agent.output_tokens;
    }
  }

  return {
    agents: agentList,
    total_agent_input_tokens: totalInput,
    total_agent_cache_read_input_tokens: totalCacheReadInput,
    total_agent_cache_creation_input_tokens: totalCacheCreationInput,
    total_agent_total_input_tokens: totalInput + totalCacheReadInput +
      totalCacheCreationInput,
    total_agent_output_tokens: totalOutput,
    total_agent_total_tokens: totalInput + totalCacheReadInput +
      totalCacheCreationInput + totalOutput,
  };
}

export function agentUsageTokenFields(): JsonObject {
  const stats = getAgentUsageStats();
  return {
    sub_agent_input_tokens: stats.total_agent_input_tokens,
    sub_agent_cache_read_input_tokens:
      stats.total_agent_cache_read_input_tokens,
    sub_agent_cache_creation_input_tokens:
      stats.total_agent_cache_creation_input_tokens,
    sub_agent_total_input_tokens: stats.total_agent_total_input_tokens,
    sub_agent_output_tokens: stats.total_agent_output_tokens,
    sub_agent_total_tokens: stats.total_agent_total_tokens,
    sub_agent_count: stats.agents.length,
  };
}

function tokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function percent(part: number, total: number): string {
  if (total <= 0) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

function color(value: string, code: string): string {
  return `${code}${value}${ANSI.reset}`;
}

function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padCell(
  value: string,
  width: number,
  align: "left" | "right",
): string {
  const padding = " ".repeat(Math.max(0, width - visibleLength(value)));
  return align === "right" ? `${padding}${value}` : `${value}${padding}`;
}

function truncateCell(value: string, width: number): string {
  const plain = value.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length <= width) return value;
  if (width <= 1) return "…";
  return `${plain.slice(0, width - 1)}…`;
}

function tableBorder(widths: number[]): string {
  return `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
}

function tableRow(
  cells: string[],
  widths: number[],
  aligns: ("left" | "right")[],
): string {
  return `| ${
    cells.map((cell, index) =>
      padCell(truncateCell(cell, widths[index]), widths[index], aligns[index])
    ).join(" | ")
  } |`;
}

export function agentUsageStatsMarkdown(): string {
  const stats = getAgentUsageStats();
  const sortedAgents = [...stats.agents].sort((left, right) =>
    right.total_tokens - left.total_tokens
  );
  const widths = [28, 10, 10, 10, 10, 10, 10, 8];
  const aligns: ("left" | "right")[] = [
    "left",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
  ];
  const lines: string[] = [
    color("Agent Token Usage", `${ANSI.bold}${ANSI.cyan}`),
    color(`Generated: ${now()}`, ANSI.gray),
    "",
    color("Totals", ANSI.bold),
    tableBorder([22, 14]),
    tableRow(["Metric", "Tokens"], [22, 14], ["left", "right"]),
    tableBorder([22, 14]),
    tableRow(
      [
        "Non-cached input",
        color(tokenCount(stats.total_agent_input_tokens), ANSI.green),
      ],
      [22, 14],
      ["left", "right"],
    ),
    tableRow(
      [
        "Cache read input",
        color(tokenCount(stats.total_agent_cache_read_input_tokens), ANSI.cyan),
      ],
      [22, 14],
      ["left", "right"],
    ),
    tableRow(
      [
        "Cache creation input",
        color(
          tokenCount(stats.total_agent_cache_creation_input_tokens),
          ANSI.yellow,
        ),
      ],
      [22, 14],
      ["left", "right"],
    ),
    tableRow(
      [
        "Total input",
        color(tokenCount(stats.total_agent_total_input_tokens), ANSI.magenta),
      ],
      [22, 14],
      ["left", "right"],
    ),
    tableRow(["Output", tokenCount(stats.total_agent_output_tokens)], [
      22,
      14,
    ], ["left", "right"]),
    tableRow(
      [
        "Total",
        color(
          tokenCount(stats.total_agent_total_tokens),
          `${ANSI.bold}${ANSI.green}`,
        ),
      ],
      [22, 14],
      ["left", "right"],
    ),
    tableRow(["Agents with usage", tokenCount(stats.agents.length)], [
      22,
      14,
    ], ["left", "right"]),
    tableBorder([22, 14]),
    "",
  ];

  if (stats.agents.length === 0) {
    lines.push(
      color(
        "No agent token usage has been recorded in this proxy process.",
        ANSI.dim,
      ),
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    color("By Agent", ANSI.bold),
    tableBorder(widths),
    tableRow(
      [
        "Agent",
        "Input",
        "Cache R",
        "Cache W",
        "Tot In",
        "Output",
        "Total",
        "Share",
      ],
      widths,
      aligns,
    ),
    tableBorder(widths),
  );

  for (const agent of sortedAgents) {
    lines.push(tableRow(
      [
        `${agent.name} ${color(agent.agent_id, ANSI.gray)}`,
        color(tokenCount(agent.input_tokens), ANSI.green),
        color(tokenCount(agent.cache_read_input_tokens), ANSI.cyan),
        color(tokenCount(agent.cache_creation_input_tokens), ANSI.yellow),
        tokenCount(agent.total_input_tokens),
        tokenCount(agent.output_tokens),
        color(tokenCount(agent.total_tokens), `${ANSI.bold}${ANSI.green}`),
        percent(agent.total_tokens, stats.total_agent_total_tokens),
      ],
      widths,
      aligns,
    ));
  }
  lines.push(tableBorder(widths));
  lines.push(
    "",
    color(
      "Legend: Cache R = cache read input, Cache W = cache creation/write input.",
      ANSI.dim,
    ),
  );

  return `${lines.join("\n")}\n`;
}

function bodyObject(ctx: RequestContext): JsonObject {
  return ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)
    ? ctx.body
    : {};
}

function stringField(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function now(): string {
  return new Date().toISOString();
}

function jsonArray(value: unknown, fallback: JsonValue[] = []): JsonValue[] {
  return Array.isArray(value) ? value as JsonValue[] : fallback;
}

function historySummaryParams(config: ProxyConfig): string {
  return JSON.stringify({
    prompt: config.augmentHistorySummaryPrompt,
    history_tail_size_tokens_to_exclude: config.augmentHistoryTailTokens,
    max_history_chars: config.augmentHistoryMaxChars,
    input_budget_trigger_ratio: 0.95,
  });
}

function activeModel(config: ProxyConfig): string {
  return config.switchApi === "CODEX" ? config.codexModel : config.openaiModel;
}

function modelInfoRegistry(config: ProxyConfig): string {
  const model = activeModel(config);
  return JSON.stringify({
    [model]: {
      humanName: model,
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
  const model = activeModel(config);
  return {
    default_model: model,
    models: [
      {
        name: model,
        internal_name: model,
        suggested_prefix_char_count: 12000,
        suggested_suffix_char_count: 12000,
        completion_timeout_ms: 3600000,
      },
    ],
    languages: [
      {
        name: "TypeScript",
        vscode_name: "typescript",
        extensions: [".ts", ".tsx"],
      },
      {
        name: "JavaScript",
        vscode_name: "javascript",
        extensions: [".js", ".jsx", ".mjs"],
      },
      { name: "Python", vscode_name: "python", extensions: [".py"] },
      { name: "Markdown", vscode_name: "markdown", extensions: [".md"] },
      { name: "JSON", vscode_name: "json", extensions: [".json"] },
    ],
    feature_flags: {
      additional_chat_models: model,
      agent_chat_model: model,
      enable_model_registry: true,
      model_info_registry: modelInfoRegistry(config),
      history_summary_min_version: "0.0.0",
      history_summary_params: historySummaryParams(config),
      beachhead_enable_sub_agent_tool: true,
      enable_hindsight: false,
      bypass_language_filter: true,
      small_sync_threshold: 1048576,
      big_sync_threshold: 10485760,
      max_upload_size_bytes: 536870912,
      cli_enable_sentry: false,
      beachhead_enable_sentry: false,
      use_intake_service_for_file_walk: false,
      cli_enable_worker_thread_path_filter: false,
      agent_max_iterations: 200,
      agent_max_total_changed_files_size_bytes: 536870912,
      idle_timeout_seconds: 3600,
      agent_report_streamed_chat_every_chunk: 1,
      beachhead_enable_parallel_tool_execution: true,
      enable_parallel_tools: true,
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
  if (path.includes("tool-permissions")) {
    return { permissions: [], allowed: true };
  }
  if (path.includes("mcp")) {
    return { configs: [], servers: [], settings: {}, tools: [] };
  }
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

function createAgentRecord(input: {
  agent_id?: string;
  agent_name?: string;
  capabilities?: JsonValue[];
  tags?: JsonValue[];
  session_config?: JsonObject;
} = {}): AgentRecord {
  const timestamp = now();
  return {
    agent_id: input.agent_id ?? `agent_${crypto.randomUUID()}`,
    agent_name: input.agent_name ?? "Local Proxy Agent",
    status: "ACTIVE",
    capabilities: input.capabilities ?? [],
    created_at: timestamp,
    updated_at: timestamp,
    tags: input.tags ?? [],
    messages: [],
    session_config: input.session_config ?? {},
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
  };
}

export function ensureFakeAgent(input: {
  agent_id?: string;
  agent_name?: string;
  capabilities?: JsonValue[];
  tags?: JsonValue[];
  session_config?: JsonObject;
} = {}): AgentRecord {
  const id = input.agent_id;
  if (id) {
    const existing = agents.get(id);
    if (existing) {
      if (input.agent_name) existing.agent_name = input.agent_name;
      if (input.capabilities) existing.capabilities = input.capabilities;
      if (input.tags) existing.tags = input.tags;
      if (input.session_config) existing.session_config = input.session_config;
      existing.updated_at = now();
      agents.set(id, existing);
      return existing;
    }
  }
  const agent = createAgentRecord(input);
  agents.set(agent.agent_id, agent);
  return agent;
}

export function resetFakeAgentsForTest(): void {
  agents.clear();
}

export function fakeCloudAgent(ctx: RequestContext): JsonObject {
  const body = bodyObject(ctx);
  const timestamp = now();

  if (ctx.path.endsWith("/create")) {
    const sessionConfig =
      body.session_config && typeof body.session_config === "object" &&
        !Array.isArray(body.session_config)
        ? body.session_config as JsonObject
        : {};
    const agent = ensureFakeAgent({
      agent_name: stringField(body.agent_name, "Local Proxy Agent"),
      capabilities: jsonArray(body.capabilities),
      session_config: {
        ...sessionConfig,
      },
    });
    return { agent: serializeAgent(agent) };
  }

  if (ctx.path.endsWith("/send-message")) {
    const id = stringField(body.agent_id, "default");
    const agent = ensureFakeAgent({
      agent_id: id,
      ...(Array.isArray(body.capabilities)
        ? { capabilities: body.capabilities }
        : {}),
    });
    if (Array.isArray(body.capabilities)) {
      agent.capabilities = body.capabilities;
    }
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
    return {
      agents: [...agents.values()].map(serializeAgent),
      next_page_token: "",
    };
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
      agent.session_config =
        body.session_config && typeof body.session_config === "object" &&
          !Array.isArray(body.session_config)
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
  if (ctx.path.endsWith("/list") || ctx.path.endsWith("/list-stream")) {
    return { agents: [], remote_agents: [] };
  }
  if (
    ctx.path.endsWith("/get-chat-history") ||
    ctx.path.endsWith("/agent-history-stream")
  ) return { chat_history: [], messages: [] };
  return { ok: true };
}

export function fakeWorkspace(path: string): JsonObject {
  if (path.endsWith("poll-update") || path.endsWith("stream")) {
    return { updates: [], events: [] };
  }
  if (path.endsWith("get-last-seq-id")) return { last_seq_id: 0 };
  return { ok: true };
}

export function fakeFindMissing(
  ctx: RequestContext,
  forceComplete = false,
): JsonObject {
  const body = bodyObject(ctx);
  const names = Array.isArray(body.mem_object_names)
    ? body.mem_object_names.filter((name): name is string =>
      typeof name === "string"
    )
    : [];
  const mode = Deno.env.get("AUGMENT_INDEXING_MODE")?.trim().toLowerCase() ||
    "capture";
  return {
    unknown_memory_names: forceComplete || mode === "complete" ? [] : names,
    nonindexed_blob_names: [],
  };
}

export function fakeBatchUpload(ctx: RequestContext): JsonObject {
  const body = bodyObject(ctx);
  const blobs = Array.isArray(body.blobs) ? body.blobs : [];
  const blobNames = blobs
    .map((blob) =>
      blob && typeof blob === "object" && !Array.isArray(blob)
        ? (blob as JsonObject).blob_name
        : undefined
    )
    .filter((name): name is string => typeof name === "string");
  return { blob_names: blobNames };
}

export function fakeCheckpointBlobs(): JsonObject {
  return { new_checkpoint_id: `checkpoint_${crypto.randomUUID()}` };
}

export function fakeGetLatestBlobset(ctx: RequestContext): JsonObject[] {
  loadIndexedCommitBlobsets();

  const body = bodyObject(ctx);
  const commitShas = Array.isArray(body.commit_shas)
    ? body.commit_shas.filter((sha): sha is string => typeof sha === "string")
    : typeof body.commit_sha === "string"
    ? [body.commit_sha]
    : [];

  for (const commitSha of commitShas) {
    const record = indexedCommitBlobsets.get(commitSha);
    if (record) {
      const fileInfos = Array.isArray(record.blobset.file_infos)
        ? record.blobset.file_infos
        : [];
      return [{
        commit_sha: commitSha,
        file_infos: JSON.parse(JSON.stringify(fileInfos)),
      }];
    }
  }

  return [];
}

export function fakeRegisterBlobset(ctx: RequestContext): JsonObject {
  loadIndexedCommitBlobsets();

  const body = bodyObject(ctx);
  const commit = jsonObjectValue(body.commit);
  const blobset = jsonObjectValue(body.blobs) ?? jsonObjectValue(body.blobset);
  const commitSha = typeof commit?.commit_sha === "string"
    ? commit.commit_sha
    : "";

  if (commit && commitSha && blobset) {
    indexedCommitBlobsets.set(commitSha, {
      commit: cloneJsonObject(commit),
      blobset: cloneJsonObject(blobset),
    });
    saveIndexedCommitBlobsets();
  }

  return { ok: true };
}

export function fakeGeneric(path: string): JsonObject {
  if (path === "chat/exchanges/list") return { chat_history: [] };
  if (path.includes("indexed-commits/get-latest-blobset")) {
    return { blobset: null, commit: null };
  }
  if (path.includes("indexed-commits/register-blobset")) return { ok: true };
  if (path.endsWith("feedback") || path.includes("feedback")) {
    return { ok: true };
  }
  if (path === "record-user-events" || path === "client-metrics") {
    return { ok: true };
  }
  return { ok: true };
}
