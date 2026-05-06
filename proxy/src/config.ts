import type { ChannelConfig, ProxyConfig, SwitchApi } from "./types.ts";
import { parse as parseToml } from "jsr:@std/toml";

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

function parseApiKeys(envVar: string, fileEnvVar: string): string[] {
  const keys: string[] = [];
  const envVal = env(envVar);
  if (envVal) {
    keys.push(...envVal.split(",").map(k => k.trim()).filter(Boolean));
  }
  const fileVal = env(fileEnvVar);
  if (fileVal) {
    try {
      const text = Deno.readTextFileSync(fileVal);
      const fileKeys = text.split(/\r?\n/)
        .map(k => k.trim())
        .filter(k => k && !k.startsWith("#"));
      keys.push(...fileKeys);
    } catch (e) {
      console.warn(`[Config] Failed to read keys from ${fileVal}: ${(e as Error).message}`);
    }
  }
  return [...new Set(keys)];
}

function loadTomlConfig(path: string): { 
  activeChannel?: string; 
  channels?: Record<string, ChannelConfig>;
  modelMapping?: Record<string, string>;
} {
  try {
    const text = Deno.readTextFileSync(path);
    const data = parseToml(text) as any;
    const channels: Record<string, ChannelConfig> = {};
    
    if (data.model_providers && typeof data.model_providers === "object") {
      for (const [id, provider] of Object.entries(data.model_providers)) {
        if (provider && typeof provider === "object") {
          const p = provider as any;
          channels[id] = {
            baseUrl: p.base_url || "",
            apiKeys: Array.isArray(p.api_keys) ? p.api_keys : (p.api_key ? [p.api_key] : []),
            model: p.model,
            modelMapping: p.model_mapping && typeof p.model_mapping === "object" ? p.model_mapping : undefined,
          };
        }
      }
    }
    
    return {
      activeChannel: data.model_provider || data.active_channel,
      channels,
      modelMapping: data.model_mapping && typeof data.model_mapping === "object" ? data.model_mapping : undefined,
    };
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.warn(`[Config] Failed to load TOML config from ${path}: ${(e as Error).message}`);
    }
    return {};
  }
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
  
  const tomlPath = env("PROXY_CONFIG_FILE", "config.toml");
  const tomlData = loadTomlConfig(tomlPath);
  
  const openaiApiKeys = parseApiKeys("OPENAI_API_KEY", "OPENAI_API_KEYS_FILE");
  const codexApiKey = env("CODEX_API_KEY");
  const codexBaseUrl = env("CODEX_BASE_URL");

  const modelMapping = tomlData.modelMapping || {};
  // Parse MODEL_MAP_ logical model mappings from env
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    if (key.startsWith("MODEL_MAP_")) {
      const logicalName = key.slice("MODEL_MAP_".length).toLowerCase().replace(/_/g, ".");
      // e.g. MODEL_MAP_GPT_5_4_MINI -> gpt.5.4.mini
      // We also handle common variants
      modelMapping[logicalName] = value;
      // Also try dash version: gpt-5.4-mini
      modelMapping[logicalName.replace(/\./g, "-")] = value;
    }
  }

  const config: ProxyConfig = {
    port: envNumber("PROXY_PORT", 8765),
    switchApi,
    activeChannel: tomlData.activeChannel || env("ACTIVE_CHANNEL", "default"),
    channels: tomlData.channels || {},
    modelMapping,
    openaiBaseUrl: normalizeBaseUrl(env("OPENAI_BASE_URL", "https://api.openai.com")),
    codexBaseUrl: codexBaseUrl ? normalizeBaseUrl(codexBaseUrl) : "",
    openaiApiKeys,
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
    embedApiKeys: parseApiKeys("EMBED_API_KEY", "EMBED_API_KEYS_FILE"),
    embedModel: env("EMBED_MODEL", "mxbai-embed-large:latest"),
    embedDimensions: envNumber("EMBED_DIMENSIONS", 1024),
    qdrantUrl: normalizeBaseUrl(env("QDRANT_URL", "http://127.0.0.1:6333")),
    qdrantCollection: env("QDRANT_COLLECTION", "augmentproxy_workspace"),
    indexChunkChars: envNumber("INDEX_CHUNK_CHARS", 1800),
    indexChunkOverlap: envNumber("INDEX_CHUNK_OVERLAP", 200),
    logLevel: env("LOG_LEVEL", "info").toLowerCase(),
  };

  // Add default channel from env if not in TOML
  if (!config.channels["default"] && config.openaiApiKeys.length > 0) {
    config.channels["default"] = {
      baseUrl: config.openaiBaseUrl,
      apiKeys: config.openaiApiKeys,
      model: config.openaiModel,
    };
  }

  if (switchApi === "OPENAI" && Object.keys(config.channels).length === 0) {
    throw new Error("No channels configured (OPENAI_API_KEY or PROXY_CONFIG_FILE)");
  }
  if (switchApi === "CODEX") {
    if (!config.codexBaseUrl) throw new Error("CODEX_BASE_URL is required when SWITCH_API=CODEX");
    if (!config.codexApiKey) throw new Error("CODEX_API_KEY is required when SWITCH_API=CODEX");
    if (!env("CODEX_MODEL")) throw new Error("CODEX_MODEL is required when SWITCH_API=CODEX");
  }

  return config;
}

export function getCurrentChannel(config: ProxyConfig): ChannelConfig | null {
  return config.channels[config.activeChannel] || config.channels["default"] || null;
}

let nextOpenaiKeyIndex = 0;
export function getNextOpenaiApiKey(config: ProxyConfig): string {
  const channel = getCurrentChannel(config);
  if (channel && channel.apiKeys.length > 0) {
    const key = channel.apiKeys[nextOpenaiKeyIndex % channel.apiKeys.length];
    nextOpenaiKeyIndex++;
    return key;
  }
  if (config.openaiApiKeys.length === 0) return "";
  const key = config.openaiApiKeys[nextOpenaiKeyIndex % config.openaiApiKeys.length];
  nextOpenaiKeyIndex++;
  return key;
}

export function getOpenAIUrl(config: ProxyConfig): string {
  const channel = getCurrentChannel(config);
  return channel ? channel.baseUrl : config.openaiBaseUrl;
}

export function getOpenAIModel(config: ProxyConfig, requestedModel?: string): string {
  const channel = getCurrentChannel(config);
  
  if (requestedModel) {
    // 1. Try channel-specific mapping
    if (channel?.modelMapping?.[requestedModel]) {
      return channel.modelMapping[requestedModel];
    }
    
    // 2. Try global mapping
    if (config.modelMapping[requestedModel]) {
      return config.modelMapping[requestedModel];
    }
  }

  return (channel && channel.model) ? channel.model : config.openaiModel;
}

export function getOpenAIKeyCount(config: ProxyConfig): number {
  const channel = getCurrentChannel(config);
  if (channel) return channel.apiKeys.length;
  return config.openaiApiKeys.length;
}

let nextEmbedKeyIndex = 0;
export function getNextEmbedApiKey(config: ProxyConfig): string {
  if (config.embedApiKeys.length === 0) return "";
  const key = config.embedApiKeys[nextEmbedKeyIndex % config.embedApiKeys.length];
  nextEmbedKeyIndex++;
  return key;
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
