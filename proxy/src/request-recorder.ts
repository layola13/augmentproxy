import type { JsonValue, RequestContext, ProxyConfig } from "./types.ts";

const SENSITIVE_KEYS = [
  "authorization",
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "apiKey",
  "token",
  "secret",
  "password",
  "client_secret",
];

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((sensitive) => lower.includes(sensitive.toLowerCase()));
}

export function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = isSensitive(key) ? "[REDACTED]" : redact(nested);
    }
    return output;
  }
  return value;
}

function headersToObject(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    output[key] = isSensitive(key) ? "[REDACTED]" : value;
  }
  return output;
}

function safePath(path: string): string {
  const cleaned = path.replace(/^\/+/, "").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned || "root";
}

function dateParts(date: Date): { day: string; stamp: string } {
  const iso = date.toISOString();
  return { day: iso.slice(0, 10), stamp: iso.replace(/[:.]/g, "-") };
}

export async function recordRequest(
  config: ProxyConfig,
  ctx: RequestContext,
  responseKind: string,
): Promise<void> {
  const now = new Date();
  const { day, stamp } = dateParts(now);
  const dir = `${config.requestLogDir}/${day}`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/${stamp}-${ctx.method}-${safePath(ctx.path)}.json`;
  const query: Record<string, string> = {};
  for (const [key, value] of ctx.url.searchParams.entries()) query[key] = value;

  const payload = {
    requestId: ctx.requestId,
    timestamp: now.toISOString(),
    method: ctx.method,
    path: ctx.path,
    query,
    headers: headersToObject(ctx.headers),
    body: ctx.body === undefined ? undefined : redact(ctx.body),
    responseKind,
  };
  await Deno.writeTextFile(file, JSON.stringify(payload, null, 2));
}
