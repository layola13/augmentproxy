import { getEncoding } from "js-tiktoken";

import type { JsonObject, JsonValue } from "./types.ts";

const encoder = getEncoding("o200k_base");

function objectValue(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function asInputList(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) return value;
  if (value === undefined) return [];
  return [value];
}

export function buildContextTokenPayload(request: JsonObject): JsonObject {
  const payload: JsonObject = {
    input: asInputList(request.input),
  };
  if (typeof request.instructions === "string" && request.instructions) {
    payload.instructions = request.instructions;
  }
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    payload.tools = request.tools;
  }
  if (request.text !== undefined) payload.text = request.text;
  if (request.reasoning !== undefined) payload.reasoning = request.reasoning;
  if (request.include !== undefined) payload.include = request.include;
  return payload;
}

export function countContextTokens(value: JsonValue): number {
  const text = JSON.stringify(value);
  return encoder.encode(text).length;
}

export function extractMessageItems(input: JsonValue[]): JsonValue[] {
  return input.filter((item) => objectValue(item).type === "message");
}
