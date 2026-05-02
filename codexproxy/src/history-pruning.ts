import type {
  HistoryPruneOptions,
  HistoryPruneStats,
  JsonObject,
  JsonValue,
  OptimizedInputResult,
  PrefixSegment,
} from "./types.ts";

const MANAGED_PREFIX_PATTERNS = [
  /^# AGENTS\.md instructions for /,
  /^<permissions instructions>/,
  /^<skills_instructions>/,
  /^<plugins_instructions>/,
  /^<apps_instructions>/,
  /^Startup context from Codex\./,
  /^<personality_spec>/,
];

export const DEFAULT_HISTORY_PRUNE_OPTIONS: HistoryPruneOptions = {
  keepRecentUserMessages: 6,
  keepRecentItems: 80,
  keepRecentFunctionCallPairs: 2,
  keepRecentReasoningItems: 2,
  keepFunctionCallName: false,
  oldToolOutputPreviewChars: 480,
  oldFunctionArgumentsPreviewChars: 240,
  dropOldReasoning: true,
};

function objectValue(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
    `[codexproxy pruned old ${label}; original_chars=${text.length}]`,
    text.slice(0, headChars),
    "...",
    text.slice(-tailChars),
  ].join("\n");
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function contentTextParts(value: JsonValue | undefined): string[] {
  const parts: string[] = [];
  for (const item of asArray(value)) {
    const record = objectValue(item);
    const type = stringValue(record.type) ?? "";
    if ((type === "input_text" || type === "output_text" || type === "summary_text") &&
      typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts;
}

function messageText(item: JsonValue | undefined): string {
  const record = objectValue(item);
  return contentTextParts(record.content).join("");
}

function outputTextForDedup(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = contentTextParts(value).join("\n");
    if (text) return text;
  }
  return JSON.stringify(value ?? null);
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

function findFirstUserMessageIndex(input: JsonValue[]): number {
  return input.findIndex((item) => itemType(item) === "message" && messageRole(item) === "user");
}

function itemCallId(item: JsonValue | undefined): string | undefined {
  return stringValue(objectValue(item).call_id);
}

function functionCallLabel(item: JsonObject): string {
  const namespace = stringValue(item.namespace);
  const name = stringValue(item.name) ?? "unknown";
  return namespace ? `${namespace}.${name}` : name;
}

function summarizeArgumentKeys(argumentsText: string | undefined): string {
  if (!argumentsText) return "";
  try {
    const parsed = JSON.parse(argumentsText) as JsonValue;
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return "";
      const keys = parsed.slice(0, 4).map((_, index) => `arg${index + 1}`);
      const suffix = parsed.length > keys.length ? `, +${parsed.length - keys.length} more` : "";
      return `${keys.join(", ")}${suffix}`;
    }
    if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed).slice(0, 8);
      const suffix = Object.keys(parsed).length > keys.length
        ? `, +${Object.keys(parsed).length - keys.length} more`
        : "";
      return `${keys.join(", ")}${suffix}`;
    }
    return "value";
  } catch {
    return "args";
  }
}

function summarizeFunctionCallOverview(item: JsonObject): string {
  const label = functionCallLabel(item);
  const argumentKeys = summarizeArgumentKeys(stringValue(item.arguments));
  return argumentKeys ? `${label}(${argumentKeys})` : `${label}()`;
}

function summarizeOverviewLines(lines: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([line, count]) =>
    count > 1 ? `${line} x${count}` : line
  );
}

function buildFunctionCallHistorySummaryMessage(lines: string[]): JsonObject {
  const summarizedLines = summarizeOverviewLines(lines);
  return {
    type: "message",
    role: "assistant",
    content: [{
      type: "output_text",
      text: [
        "[codexproxy historical function calls summary]",
        ...summarizedLines.map((line) => `- ${line}`),
      ].join("\n"),
    }],
    phase: "commentary",
  };
}

function collectRetainedReasoningIndexes(
  input: JsonValue[],
  keepRecentReasoningItems: number,
): Set<number> {
  const retained = new Set<number>();
  if (keepRecentReasoningItems <= 0) return retained;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (itemType(input[index]) !== "reasoning") continue;
    retained.add(index);
    if (retained.size >= keepRecentReasoningItems) break;
  }
  return retained;
}

function collectRetainedFunctionCallIds(
  input: JsonValue[],
  keepRecentFunctionCallPairs: number,
): Set<string> {
  const retained = new Set<string>();
  if (keepRecentFunctionCallPairs <= 0) return retained;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (itemType(input[index]) !== "function_call") continue;
    const callId = itemCallId(input[index]);
    if (!callId || retained.has(callId)) continue;
    retained.add(callId);
    if (retained.size >= keepRecentFunctionCallPairs) break;
  }
  return retained;
}

function collectDroppedFunctionCallOverviewLines(
  input: JsonValue[],
  retainedFunctionCallIds: Set<string>,
): string[] {
  const lines: string[] = [];
  for (const item of input) {
    if (itemType(item) !== "function_call") continue;
    const callId = itemCallId(item);
    if (callId && retainedFunctionCallIds.has(callId)) continue;
    lines.push(summarizeFunctionCallOverview(objectValue(item)));
  }
  return lines;
}

function countCodeBlocks(text: string): number {
  const matches = text.match(/```[\s\S]*?```/g);
  return matches ? matches.length : 0;
}

function compactFencedCodeBlocks(text: string): string {
  return text.replace(/```([\s\S]*?)```/g, (block, code) => {
    const lines = code.replace(/^\n+|\n+$/g, "").split("\n");
    if (lines.length <= 20 && block.length <= 1600) return block;
    const head = lines.slice(0, 8).join("\n");
    const tail = lines.slice(-6).join("\n");
    const middleNotice = `[codexproxy compressed code block; original_lines=${lines.length}; original_chars=${block.length}]`;
    return `\`\`\`\n${head}\n${middleNotice}\n${tail}\n\`\`\``;
  });
}

function compactPinnedUserItem(item: JsonObject): { item: JsonObject; compactedCodeBlocks: number } {
  const content = Array.isArray(item.content) ? item.content : [];
  let compactedCodeBlocks = 0;
  const nextContent = content.map((part) => {
    const record = objectValue(part);
    if (stringValue(record.type) !== "input_text" || typeof record.text !== "string") return part;
    compactedCodeBlocks += countCodeBlocks(record.text);
    return {
      ...record,
      text: compactFencedCodeBlocks(record.text),
    };
  });
  if (compactedCodeBlocks === 0) return { item, compactedCodeBlocks: 0 };
  return {
    item: {
      ...item,
      content: nextContent,
    },
    compactedCodeBlocks,
  };
}

function isManagedPrefixMessage(item: JsonValue | undefined): boolean {
  const type = itemType(item);
  if (type !== "message") return false;
  const text = messageText(item);
  return MANAGED_PREFIX_PATTERNS.some((pattern) => pattern.test(text));
}

function pruneFunctionCallOutput(item: JsonObject, options: HistoryPruneOptions): {
  value: JsonObject;
  truncated: boolean;
} {
  const output = item.output;
  if (typeof output === "string") {
    const summarized = summarizeText(output, options.oldToolOutputPreviewChars, "tool output");
    return summarized === output
      ? { value: item, truncated: false }
      : { value: { ...item, output: summarized }, truncated: true };
  }
  if (Array.isArray(output)) {
    const joined = outputTextForDedup(output);
    const summarized = summarizeText(joined, options.oldToolOutputPreviewChars, "tool output");
    if (summarized === joined) return { value: item, truncated: false };
    return {
      value: {
        ...item,
        output: [{ type: "input_text", text: summarized }],
      },
      truncated: true,
    };
  }
  return { value: item, truncated: false };
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

function isRemoteCompactCandidate(
  item: JsonValue,
  index: number,
  firstUserIndex: number,
): boolean {
  const type = itemType(item);
  const role = messageRole(item);
  if (isManagedPrefixMessage(item)) return false;
  if (role === "developer" || role === "user") return false;
  if (index === firstUserIndex) return false;
  if (type === "function_call" || type === "function_call_output") return false;
  return true;
}

export function optimizeRequestInput(
  requestInput: JsonValue[],
  options: HistoryPruneOptions = DEFAULT_HISTORY_PRUNE_OPTIONS,
): OptimizedInputResult {
  const summary: HistoryPruneStats = {
    inputCountBefore: requestInput.length,
    inputCountAfter: requestInput.length,
    bytesBefore: jsonLength(requestInput),
    bytesAfter: jsonLength(requestInput),
    preservedFromIndex: requestInput.length,
    droppedReasoningCount: 0,
    droppedFunctionCallCount: 0,
    droppedFunctionCallOutputCount: 0,
    truncatedToolOutputCount: 0,
    truncatedFunctionCallCount: 0,
    dedupedFunctionCallCount: 0,
    dedupedFunctionCallOutputCount: 0,
    compactedPinnedUserCodeBlockCount: 0,
    remoteCompactCandidateCount: 0,
    remoteCompactCandidateBytes: 0,
  };

  if (requestInput.length === 0) {
    return {
      localInput: [],
      prefixSegments: [],
      suffixItems: [],
      stats: summary,
    };
  }

  const preservedFromIndex = findPreservedStartIndex(requestInput, options);
  summary.preservedFromIndex = preservedFromIndex;
  const firstUserIndex = findFirstUserMessageIndex(requestInput);
  const retainedReasoningIndexes = collectRetainedReasoningIndexes(
    requestInput,
    options.keepRecentReasoningItems,
  );
  const retainedFunctionCallIds = collectRetainedFunctionCallIds(
    requestInput,
    options.keepRecentFunctionCallPairs,
  );
  const droppedFunctionCallOverviewLines = options.keepFunctionCallName
    ? collectDroppedFunctionCallOverviewLines(requestInput, retainedFunctionCallIds)
    : [];
  const functionCallHistorySummary = droppedFunctionCallOverviewLines.length > 0
    ? buildFunctionCallHistorySummaryMessage(droppedFunctionCallOverviewLines)
    : undefined;
  let functionCallSummaryInserted = false;

  const localInput: JsonValue[] = [];
  const prefixSegments: PrefixSegment[] = [];
  const suffixItems: JsonValue[] = [];

  for (let index = 0; index < requestInput.length; index += 1) {
    if (!functionCallSummaryInserted && functionCallHistorySummary && index >= preservedFromIndex) {
      localInput.push(functionCallHistorySummary);
      prefixSegments.push({ item: functionCallHistorySummary, compressible: false });
      functionCallSummaryInserted = true;
    }

    const item = requestInput[index];
    const type = itemType(item);
    const record = objectValue(item);

    if (type === "reasoning" && options.dropOldReasoning && !retainedReasoningIndexes.has(index)) {
      summary.droppedReasoningCount += 1;
      continue;
    }

    if (type === "function_call") {
      const callId = itemCallId(item);
      if (!callId || !retainedFunctionCallIds.has(callId)) {
        summary.droppedFunctionCallCount += 1;
        continue;
      }
    }

    if (type === "function_call_output") {
      const callId = itemCallId(item);
      if (!callId || !retainedFunctionCallIds.has(callId)) {
        summary.droppedFunctionCallOutputCount += 1;
        continue;
      }
    }

    let nextItem: JsonValue = item;
    if (index < preservedFromIndex && type === "function_call_output") {
      const pruned = pruneFunctionCallOutput(record, options);
      if (pruned.truncated) summary.truncatedToolOutputCount += 1;
      nextItem = pruned.value;
    } else if (index < preservedFromIndex && type === "function_call") {
      const pruned = pruneFunctionCall(record, options);
      if (pruned.truncated) summary.truncatedFunctionCallCount += 1;
      nextItem = pruned.value;
    } else if (
      index < preservedFromIndex &&
      index === firstUserIndex &&
      type === "message" &&
      messageRole(item) === "user"
    ) {
      const compacted = compactPinnedUserItem(record);
      summary.compactedPinnedUserCodeBlockCount += compacted.compactedCodeBlocks;
      nextItem = compacted.item;
    }

    localInput.push(nextItem);

    if (index < preservedFromIndex) {
      const compressible = isRemoteCompactCandidate(nextItem, index, firstUserIndex);
      prefixSegments.push({ item: nextItem, compressible });
      if (compressible) {
        summary.remoteCompactCandidateCount += 1;
        summary.remoteCompactCandidateBytes += jsonLength(nextItem);
      }
    } else {
      suffixItems.push(nextItem);
    }
  }

  if (!functionCallSummaryInserted && functionCallHistorySummary) {
    localInput.push(functionCallHistorySummary);
    prefixSegments.push({ item: functionCallHistorySummary, compressible: false });
  }

  summary.inputCountAfter = localInput.length;
  summary.bytesAfter = jsonLength(localInput);
  return {
    localInput,
    prefixSegments,
    suffixItems,
    stats: summary,
  };
}

function renderMessage(item: JsonObject): string {
  const role = stringValue(item.role) ?? "unknown";
  const text = messageText(item).trim();
  return `${role.toUpperCase()}:\n${text || "<empty>"}`;
}

export function renderItemForRemoteCompact(item: JsonValue): string {
  const record = objectValue(item);
  const type = stringValue(record.type) ?? "unknown";
  if (type === "message") {
    return renderMessage(record);
  }
  if (type === "function_call") {
    const namespace = stringValue(record.namespace);
    const name = stringValue(record.name) ?? "unknown";
    const label = namespace ? `${namespace}.${name}` : name;
    return `TOOL CALL ${label}:\n${stringValue(record.arguments) ?? "{}"}`;
  }
  if (type === "function_call_output") {
    return `TOOL RESULT ${stringValue(record.call_id) ?? "unknown"}:\n${
      outputTextForDedup(record.output)
    }`;
  }
  if (type === "compaction") {
    return `OLDER SUMMARY:\n${stringValue(record.encrypted_content) ?? ""}`;
  }
  return `${type.toUpperCase()}:\n${JSON.stringify(item, null, 2)}`;
}

export function buildRemoteCompactPayload(
  prefixSegments: PrefixSegment[],
): { pinnedContext: string; compressibleHistory: string } {
  const pinnedParts: string[] = [];
  const compressibleParts: string[] = [];
  for (const segment of prefixSegments) {
    const rendered = renderItemForRemoteCompact(segment.item).trim();
    if (!rendered) continue;
    if (segment.compressible) compressibleParts.push(rendered);
    else pinnedParts.push(rendered);
  }
  return {
    pinnedContext: pinnedParts.join("\n\n"),
    compressibleHistory: compressibleParts.join("\n\n"),
  };
}

export function buildSummaryMessage(summaryPrefix: string, summaryText: string): JsonObject {
  return {
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: `${summaryPrefix.trim()}\n${summaryText.trim()}`,
    }],
  };
}
