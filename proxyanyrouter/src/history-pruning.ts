import type { JsonObject, JsonValue } from "./types.ts";

export interface HistoryPruneOptions {
  keepRecentUserMessages: number;
  keepRecentItems: number;
  oldToolOutputPreviewChars: number;
  oldFunctionArgumentsPreviewChars: number;
  dropOldReasoning: boolean;
}

export interface HistoryPruneSummary {
  inputCountBefore: number;
  inputCountAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  preservedFromIndex: number;
  droppedReasoningCount: number;
  truncatedToolOutputCount: number;
  truncatedFunctionCallCount: number;
}

export const DEFAULT_HISTORY_PRUNE_OPTIONS: HistoryPruneOptions = {
  keepRecentUserMessages: 6,
  keepRecentItems: 80,
  oldToolOutputPreviewChars: 480,
  oldFunctionArgumentsPreviewChars: 240,
  dropOldReasoning: true,
};

function objectValue(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function itemType(value: JsonValue | undefined): string {
  return typeof objectValue(value).type === "string" ? objectValue(value).type as string : "";
}

function messageRole(value: JsonValue | undefined): string {
  return typeof objectValue(value).role === "string" ? objectValue(value).role as string : "";
}

function jsonLength(value: JsonValue): number {
  return JSON.stringify(value).length;
}

function summarizeText(text: string, previewChars: number, label: string): string {
  if (text.length <= previewChars) return text;
  const headChars = Math.max(80, Math.floor(previewChars * 0.7));
  const tailChars = Math.max(40, previewChars - headChars);
  return [
    `[proxyanyrouter pruned old ${label}; original_chars=${text.length}]`,
    text.slice(0, headChars),
    "...",
    text.slice(-tailChars),
  ].join("\n");
}

function findPreservedStartIndex(input: JsonValue[], options: HistoryPruneOptions): number {
  const recentItemsStart = Math.max(0, input.length - options.keepRecentItems);
  let remainingUsers = options.keepRecentUserMessages;
  let recentUserStart = 0;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (itemType(input[index]) === "message" && messageRole(input[index]) === "user") {
      remainingUsers -= 1;
      recentUserStart = index;
      if (remainingUsers <= 0) break;
    }
  }
  return Math.max(0, Math.min(recentItemsStart, recentUserStart));
}

function pruneFunctionCallOutput(item: JsonObject, options: HistoryPruneOptions): {
  value: JsonObject;
  truncated: boolean;
} {
  const output = item.output;
  if (typeof output !== "string") {
    return { value: item, truncated: false };
  }
  const summarized = summarizeText(output, options.oldToolOutputPreviewChars, "tool output");
  if (summarized === output) {
    return { value: item, truncated: false };
  }
  return {
    value: {
      ...item,
      output: summarized,
    },
    truncated: true,
  };
}

function pruneFunctionCall(item: JsonObject, options: HistoryPruneOptions): {
  value: JsonObject;
  truncated: boolean;
} {
  const args = item.arguments;
  if (typeof args !== "string") {
    return { value: item, truncated: false };
  }
  const summarized = summarizeText(
    args,
    options.oldFunctionArgumentsPreviewChars,
    "function arguments",
  );
  if (summarized === args) {
    return { value: item, truncated: false };
  }
  return {
    value: {
      ...item,
      arguments: summarized,
    },
    truncated: true,
  };
}

export function pruneRequestHistory(
  request: JsonObject,
  options: HistoryPruneOptions = DEFAULT_HISTORY_PRUNE_OPTIONS,
): { request: JsonObject; summary: HistoryPruneSummary } {
  const input = Array.isArray(request.input) ? request.input : [];
  const summary: HistoryPruneSummary = {
    inputCountBefore: input.length,
    inputCountAfter: input.length,
    bytesBefore: jsonLength(input),
    bytesAfter: jsonLength(input),
    preservedFromIndex: input.length,
    droppedReasoningCount: 0,
    truncatedToolOutputCount: 0,
    truncatedFunctionCallCount: 0,
  };

  if (input.length === 0) {
    return { request, summary };
  }

  const preservedFromIndex = findPreservedStartIndex(input, options);
  summary.preservedFromIndex = preservedFromIndex;
  const nextInput: JsonValue[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (index >= preservedFromIndex) {
      nextInput.push(item);
      continue;
    }

    const type = itemType(item);
    if (type === "reasoning" && options.dropOldReasoning) {
      summary.droppedReasoningCount += 1;
      continue;
    }
    if (type === "function_call_output") {
      const pruned = pruneFunctionCallOutput(objectValue(item), options);
      if (pruned.truncated) summary.truncatedToolOutputCount += 1;
      nextInput.push(pruned.value);
      continue;
    }
    if (type === "function_call") {
      const pruned = pruneFunctionCall(objectValue(item), options);
      if (pruned.truncated) summary.truncatedFunctionCallCount += 1;
      nextInput.push(pruned.value);
      continue;
    }
    nextInput.push(item);
  }

  summary.inputCountAfter = nextInput.length;
  summary.bytesAfter = jsonLength(nextInput);
  return {
    request: {
      ...request,
      input: nextInput,
    },
    summary,
  };
}
