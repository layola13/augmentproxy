import type { ProxyConfig } from "./types.ts";

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

export function loadConfig(): ProxyConfig {
  const openaiApiKey = env("OPENAI_API_KEY");
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  return {
    port: envNumber("PROXY_PORT", 8765),
    openaiBaseUrl: normalizeBaseUrl(env("OPENAI_BASE_URL", "https://api.openai.com")),
    openaiApiKey,
    openaiModel: env("OPENAI_MODEL", "gpt-4o-mini"),
    openaiUserAgent: env("OPENAI_USER_AGENT", "codex-cli"),
    upstreamAppName: env("OPENAI_UPSTREAM_APP_NAME", "Codex"),
    sanitizeUpstreamPrompts: envBoolean("OPENAI_SANITIZE_UPSTREAM_PROMPTS", false),
    fakeAugmentEmail: env("FAKE_AUGMENT_EMAIL", "proxy@example.local"),
    fakeAugmentUserId: env("FAKE_AUGMENT_USER_ID", "user_proxy_local"),
    requestLogDir: normalizeLogDir(env("AUGMENT_REQUEST_LOG_DIR", "logs")),
    indexingMode: env("AUGMENT_INDEXING_MODE", "capture").toLowerCase(),
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
