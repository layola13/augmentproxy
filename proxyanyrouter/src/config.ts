import type { ProxyAnyRouterConfig } from "./types.ts";

function env(name: string, fallback = ""): string {
  return Deno.env.get(name)?.trim() || fallback;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envContinuationMode(): "replay" | "previous_response_id" {
  return env("PROXYANYROUTER_CONTINUATION_MODE") === "previous_response_id"
    ? "previous_response_id"
    : "replay";
}

function resolvePath(path: string): string {
  if (path.startsWith("/")) return path;
  return new URL(path, import.meta.url).pathname;
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

export function loadConfig(): ProxyAnyRouterConfig {
  return {
    port: envNumber("PROXYANYROUTER_PORT", 8876),
    upstreamUrl: env(
      "PROXYANYROUTER_UPSTREAM_URL",
      "http://127.0.0.1:8877/v1/responses",
    ),
    upstreamApiKey: env("PROXYANYROUTER_UPSTREAM_API_KEY"),
    mcpConfigPath: resolvePath(
      env("PROXYANYROUTER_MCP_CONFIG", "../mcp-tools.json"),
    ),
    logDir: resolvePath(
      env("PROXYANYROUTER_LOG_DIR", "../logs"),
    ),
    heartbeatMs: envNumber("PROXYANYROUTER_HEARTBEAT_MS", 5000),
    maxBridgeSteps: envNumber("PROXYANYROUTER_MAX_STEPS", 6),
    continuationMode: envContinuationMode(),
  };
}

export async function loadConfigFromEnvFile(): Promise<ProxyAnyRouterConfig> {
  await loadDotEnvFile(".env");
  await loadDotEnvFile("proxyanyrouter/.env");
  return loadConfig();
}
