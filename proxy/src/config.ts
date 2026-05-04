import type { ProxyConfig, SwitchApi } from "./types.ts";

function env(name: string, fallback = ""): string {
  return Deno.env.get(name)?.trim() || fallback;
}


function envNumber(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = env(name).toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function normalizeSwitchApi(value: string): SwitchApi {
  const normalized = value.trim().toUpperCase();
  if (!normalized || normalized === "OPENAI") return "OPENAI";
  if (normalized === "CODEX") return "CODEX";
  throw new Error("SWITCH_API must be OPENAI or CODEX");
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || "https://api.openai.com";
}

function normalizeEmbedBaseUrl(value: string): string {
  const base = normalizeBaseUrl(value);
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function normalizeLogDir(value: string): string {
  if (value === "proxy/logs" && new URL(".", import.meta.url).pathname.endsWith("/proxy/src/")) {
    return "logs";
  }
  return value;
}

const defaultHistorySummaryPrompt = [
  "Create a compact continuation summary for this agent conversation.",
  "Preserve the user's explicit instructions, current objective, important decisions, files changed or inspected, commands run, test results, unresolved errors, and the next concrete steps.",
  "Do not invent facts. Prefer exact paths, symbols, command names, and error messages over general descriptions.",
  "Write the summary so the agent can continue the same task after context compaction without re-reading unrelated history.",
].join("\n");

export function loadConfig(): ProxyConfig {
  const switchApi = normalizeSwitchApi(
    env("SWITCH_API") || env("SWTICHAPI") || env("SWITCHAPI") || "OPENAI",
  );
  const openaiApiKey = env("OPENAI_API_KEY");
  const codexApiKey = env("CODEX_API_KEY");
  const codexBaseUrl = env("CODEX_BASE_URL");
  if (switchApi === "OPENAI" && !openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }
  if (switchApi === "CODEX") {
    if (!codexBaseUrl) throw new Error("CODEX_BASE_URL is required when SWITCH_API=CODEX");
    if (!codexApiKey) throw new Error("CODEX_API_KEY is required when SWITCH_API=CODEX");
    if (!env("CODEX_MODEL")) throw new Error("CODEX_MODEL is required when SWITCH_API=CODEX");
  }

  return {
    port: envNumber("PROXY_PORT", 8765),
    switchApi,
    openaiBaseUrl: normalizeBaseUrl(env("OPENAI_BASE_URL", "https://api.openai.com")),
    codexBaseUrl: codexBaseUrl ? normalizeBaseUrl(codexBaseUrl) : "",
    openaiApiKey,
    codexApiKey,
    openaiModel: env("OPENAI_MODEL", "gpt-4o-mini"),
    codexModel: env("CODEX_MODEL"),
    openaiUserAgent: env("OPENAI_USER_AGENT", "codex-cli"),
    upstreamAppName: env("OPENAI_UPSTREAM_APP_NAME", "Codex"),
    sanitizeUpstreamPrompts: envBoolean("OPENAI_SANITIZE_UPSTREAM_PROMPTS", false),
    augmentModelContextTokens: envNumber("AUGMENT_MODEL_CONTEXT_TOKENS", 200000),
    augmentModelMaxOutputTokens: envNumber("AUGMENT_MODEL_MAX_OUTPUT_TOKENS", 16000),
    augmentHistoryTailTokens: envNumber("AUGMENT_HISTORY_TAIL_TOKENS", 32000),
    augmentHistoryMaxChars: envNumber("AUGMENT_HISTORY_MAX_CHARS", 2000000),
    augmentHistorySummaryPrompt: env("AUGMENT_HISTORY_SUMMARY_PROMPT", defaultHistorySummaryPrompt),
    fakeAugmentEmail: env("FAKE_AUGMENT_EMAIL", "proxy@example.local"),
    fakeAugmentUserId: env("FAKE_AUGMENT_USER_ID", "user_proxy_local"),
    requestLogDir: normalizeLogDir(env("AUGMENT_REQUEST_LOG_DIR", "logs")),
    indexingMode: env("AUGMENT_INDEXING_MODE", "complete").toLowerCase(),
    embedBaseUrl: normalizeEmbedBaseUrl(env("EMBED_BASE_URL", "http://127.0.0.1:11434")),
    embedApiKey: env("EMBED_API_KEY"),
    embedModel: env("EMBED_MODEL", "mxbai-embed-large:latest"),
    embedDimensions: envNumber("EMBED_DIMENSIONS", 1024),
    qdrantUrl: normalizeBaseUrl(env("QDRANT_URL", "http://127.0.0.1:6333")),
    qdrantCollection: env("QDRANT_COLLECTION", "augmentproxy_workspace"),
    indexChunkChars: envNumber("INDEX_CHUNK_CHARS", 1800),
    indexChunkOverlap: envNumber("INDEX_CHUNK_OVERLAP", 200),
    logLevel: env("LOG_LEVEL", "info").toLowerCase(),
  };
}

async function loadDotEnvFile(path = ".env"): Promise<void> {
  try {
    const text = await Deno.readTextFile(path);
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!Deno.env.get(key)) Deno.env.set(key, value);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export async function loadConfigFromEnvFile(): Promise<ProxyConfig> {
  await loadDotEnvFile(".env");
  await loadDotEnvFile("proxy/.env");
  return loadConfig();
}
