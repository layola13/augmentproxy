import type { CodexProxyConfig } from "./types.ts";

const PROJECT_ROOT_URL = new URL("../", import.meta.url);
const WORKSPACE_ROOT_URL = new URL("../../", import.meta.url);

function env(name: string, fallback = ""): string {
  return Deno.env.get(name)?.trim() || fallback;
}

function envFirst(names: string[], fallback = ""): string {
  for (const name of names) {
    const value = env(name);
    if (value) return value;
  }
  return fallback;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envNumberFirst(names: string[], fallback: number): number {
  for (const name of names) {
    const value = Number(env(name));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const value = env(name).toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function envBooleanFirst(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const raw = Deno.env.get(name);
    if (raw === undefined) continue;
    const value = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
  }
  return fallback;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeResponsesUrl(value: string): string {
  const normalized = normalizeBaseUrl(value);
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function resolvePath(path: string): string {
  if (path.startsWith("/")) return path;
  return new URL(path, PROJECT_ROOT_URL).pathname;
}

function filePathFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname);
}

async function loadDotEnvFile(path: string): Promise<void> {
  try {
    const text = await Deno.readTextFile(path);
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!Deno.env.get(key)) Deno.env.set(key, value);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export function loadConfig(): CodexProxyConfig {
  const enableCompactModel = envBoolean("ENABLE_COMPACT_MODEL", true);
  const codexBaseUrl = envFirst(
    ["CODEX_BASE_URL", "CODEXPROXY_BASE_URL", "BASEURL", "baseurl", "OPENAI_BASE_URL"],
  );
  const codexApiKey = envFirst(
    ["CODEX_API_KEY", "CODEXPROXY_API_KEY", "APIKEY", "apikey", "OPENAI_API_KEY"],
  );
  const liteBaseUrl = envFirst(
    ["LITE_BASE_URL", "COMPACT_BASE_URL", "DOCS_BASE_URL", "BASEURL", "baseurl", "OPENAI_BASE_URL"],
  );
  const liteApiKey = envFirst(
    ["LITE_API_KEY", "COMPACT_API_KEY", "DOCS_API_KEY", "APIKEY", "apikey", "OPENAI_API_KEY"],
  );
  const liteModel = envFirst(
    ["LITE_MODEL", "COMPACT_MODEL", "DOC_MODEL", "CODEXPROXY_MODEL", "MODEL", "model", "OPENAI_MODEL"],
  );
  const defaultModel = envFirst(["CODEX_DEFAULT_MODEL", "DEFAULT_MODEL", "OPENAI_MODEL"]);
  const codeModel = envFirst(["CODEX_CODE_MODEL", "CODE_MODEL"], defaultModel);
  const planModel = envFirst(["CODEX_PLAN_MODEL", "PLAN_MODEL"], defaultModel);
  const docModel = envFirst(["CODEX_DOC_MODEL", "DOC_MODEL"], defaultModel);
  const proxyApiKey = envFirst(["PROXY_API_KEY", "CODEXPROXY_ACCESS_KEY", "API_KEY"]);

  if (!codexBaseUrl) {
    throw new Error("Missing CODEX base URL. Set CODEX_BASE_URL.");
  }
  if (!codexApiKey) {
    throw new Error("Missing CODEX API key. Set CODEX_API_KEY.");
  }
  if (enableCompactModel && !liteBaseUrl) {
    throw new Error("Missing LITE base URL. Set LITE_BASE_URL.");
  }
  if (enableCompactModel && !liteApiKey) {
    throw new Error("Missing LITE API key. Set LITE_API_KEY.");
  }
  if (enableCompactModel && !liteModel) {
    throw new Error("Missing LITE model. Set LITE_MODEL.");
  }
  if (!defaultModel) {
    throw new Error("Missing default CODEX model. Set DEFAULT_MODEL or CODEX_DEFAULT_MODEL.");
  }

  return {
    port: envNumberFirst(["CODEXPROXY_PORT", "PROXY_PORT", "PORT"], 8878),
    codexUpstream: {
      url: normalizeResponsesUrl(codexBaseUrl),
      apiKey: codexApiKey,
    },
    enableCompactModel,
    liteUpstream: enableCompactModel
      ? {
        url: normalizeResponsesUrl(liteBaseUrl),
        apiKey: liteApiKey,
      }
      : undefined,
    liteModel: enableCompactModel ? liteModel : undefined,
    autoModels: {
      defaultModel,
      codeModel: codeModel || defaultModel,
      planModel: planModel || defaultModel,
      docModel: docModel || defaultModel,
    },
    proxyApiKey: proxyApiKey || undefined,
    codexRoot: resolvePath(env("CODEXPROXY_CODEX_ROOT", "/home/vscode/projects/codex")),
    logDir: resolvePath(env("CODEXPROXY_LOG_DIR", "../logs")),
    heartbeatMs: envNumber("CODEXPROXY_HEARTBEAT_MS", 5000),
    requestTimeoutMs: envNumber("CODEXPROXY_REQUEST_TIMEOUT_MS", 180000),
    localPruneMinTokens: envNumber("CODEXPROXY_LOCAL_PRUNE_MIN_TOKENS", 180000),
    keepRecentUserMessages: envNumber("CODEXPROXY_KEEP_RECENT_USER_MESSAGES", 6),
    keepRecentItems: envNumber("CODEXPROXY_KEEP_RECENT_ITEMS", 80),
    keepRecentFunctionCallPairs: envNumber("CODEXPROXY_KEEP_RECENT_FUNCTION_CALL_PAIRS", 2),
    keepRecentReasoningItems: envNumber("CODEXPROXY_KEEP_RECENT_REASONING_ITEMS", 2),
    keepFunctionCallName: envBooleanFirst(
      ["KEEP_FUNCTIONCALL_NAME", "keep_functioncall_name", "CODEXPROXY_KEEP_FUNCTIONCALL_NAME"],
      false,
    ),
    oldToolOutputPreviewChars: envNumber("CODEXPROXY_OLD_TOOL_OUTPUT_PREVIEW_CHARS", 480),
    oldFunctionArgumentsPreviewChars: envNumber(
      "CODEXPROXY_OLD_FUNCTION_ARGUMENTS_PREVIEW_CHARS",
      240,
    ),
    dropOldReasoning: envBoolean("CODEXPROXY_DROP_OLD_REASONING", true),
  };
}

export async function loadConfigFromEnvFile(): Promise<CodexProxyConfig> {
  await loadDotEnvFile(".env");
  await loadDotEnvFile(`${filePathFromUrl(PROJECT_ROOT_URL)}.env`);
  await loadDotEnvFile(`${filePathFromUrl(WORKSPACE_ROOT_URL)}.env`);
  await loadDotEnvFile(`${filePathFromUrl(WORKSPACE_ROOT_URL)}proxy/.env`);
  return loadConfig();
}
