import type { JsonValue, RequestContext } from "./types.ts";

export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function textResponse(value: string, status = 200, headers?: HeadersInit): Response {
  return new Response(value, { status, headers });
}

export function augmentError(message: string, status = 500, code = "internal"): Response {
  return jsonResponse({ error: { message, code, status } }, status);
}

function requestId(headers: Headers): string {
  return headers.get("x-request-id") || crypto.randomUUID();
}

export async function parseRequest(request: Request): Promise<RequestContext> {
  const url = new URL(request.url);
  const rawBody = ["GET", "HEAD"].includes(request.method) ? "" : await request.text();
  let body: JsonValue | undefined;
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as JsonValue;
    } catch {
      body = rawBody;
    }
  }
  return {
    requestId: requestId(request.headers),
    method: request.method.toUpperCase(),
    url,
    path: url.pathname.replace(/^\/+/, ""),
    headers: request.headers,
    body,
    rawBody,
  };
}
