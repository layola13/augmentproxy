import type { JsonObject, ProxyAnyRouterConfig } from "./types.ts";

export interface RequestLogContext {
  requestId: string;
  requestDir: string;
}

function timestamp(): string {
  return new Date().toISOString();
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function scrubSecret(key: string, value: unknown): unknown {
  const lower = key.toLowerCase();
  if (
    lower.includes("authorization") ||
    lower.includes("api-key") ||
    lower.includes("apikey") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("cookie")
  ) {
    return "<redacted>";
  }
  return value;
}

export function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = scrubSecret(key, redactObject(nested));
  }
  return output;
}

export function logLine(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>,
): void {
  const suffix = meta ? ` ${JSON.stringify(redactObject(meta))}` : "";
  console.log(`[${timestamp()}] ${level} ${message}${suffix}`);
}

export async function ensureLogDir(config: ProxyAnyRouterConfig): Promise<void> {
  await Deno.mkdir(config.logDir, { recursive: true });
}

export async function createRequestLogContext(
  config: ProxyAnyRouterConfig,
  requestId: string,
): Promise<RequestLogContext> {
  await ensureLogDir(config);
  const requestDir = `${config.logDir}/${requestId}`;
  await Deno.mkdir(requestDir, { recursive: true });
  return { requestId, requestDir };
}

export async function appendEventLog(
  config: ProxyAnyRouterConfig,
  event: JsonObject,
): Promise<void> {
  await ensureLogDir(config);
  const path = `${config.logDir}/events.jsonl`;
  const payload = {
    ts: timestamp(),
    ...redactObject(event) as Record<string, unknown>,
  };
  await Deno.writeTextFile(path, `${JSON.stringify(payload)}\n`, { append: true });
}

export async function writeJsonArtifact(
  ctx: RequestLogContext,
  name: string,
  value: unknown,
): Promise<string> {
  const path = `${ctx.requestDir}/${name}`;
  await Deno.writeTextFile(
    path,
    ensureTrailingNewline(JSON.stringify(redactObject(value), null, 2)),
  );
  return path;
}

export async function writeTextArtifact(
  ctx: RequestLogContext,
  name: string,
  value: string,
): Promise<string> {
  const path = `${ctx.requestDir}/${name}`;
  await Deno.writeTextFile(path, ensureTrailingNewline(value));
  return path;
}

export function headersToObject(headers: Headers): JsonObject {
  return Object.fromEntries(headers.entries());
}
