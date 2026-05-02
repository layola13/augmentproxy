import type { ProxyAnyRouterConfig } from "./types.ts";

function env(name: string, fallback = ""): string {
  return Deno.env.get(name)?.trim() || fallback;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(env(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolvePath(path: string): string {
  if (path.startsWith("/")) return path;
  return new URL(path, import.meta.url).pathname;
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
    heartbeatMs: envNumber("PROXYANYROUTER_HEARTBEAT_MS", 5000),
    maxBridgeSteps: envNumber("PROXYANYROUTER_MAX_STEPS", 6),
  };
}
