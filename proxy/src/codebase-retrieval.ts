import type {
  JsonObject,
  JsonValue,
  ProxyConfig,
  RequestContext,
} from "./types.ts";
import { resolveCheckpointBlobNames, searchIndexedChunks } from "./indexer.ts";
import { logInfo } from "./logger.ts";

interface RetrievalRequest {
  informationRequest: string;
  checkpointId?: string;
  addedBlobs: string[];
  deletedBlobs: string[];
  workspaceRoot?: string;
  currentWorkingDirectory?: string;
  maxOutputLength: number;
}

function bodyObject(ctx: RequestContext): JsonObject {
  return ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)
    ? ctx.body
    : {};
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseRequest(ctx: RequestContext): RetrievalRequest {
  const body = bodyObject(ctx);
  const blobs = asObject(body.blobs) ?? {};
  const addedBlobs = asArray(blobs.added_blobs).filter((item): item is string =>
    typeof item === "string"
  );
  const deletedBlobs = asArray(blobs.deleted_blobs).filter((
    item,
  ): item is string => typeof item === "string");
  const dialog = asArray(body.dialog);

  let workspaceRoot = stringValue(body.workspace_folder) ??
    stringValue(body.directory_path);
  let currentWorkingDirectory: string | undefined;
  let requestText = stringValue(body.information_request);

  for (const entry of dialog) {
    const record = asObject(entry);
    if (!record) continue;
    for (const node of asArray(record.request_nodes)) {
      const nodeRecord = asObject(node);
      if (!nodeRecord) continue;

      const textNode = asObject(nodeRecord.text_node);
      const content = stringValue(textNode?.content);
      if (!requestText && content) requestText = content;

      const ideStateNode = asObject(nodeRecord.ide_state_node);
      if (!ideStateNode) continue;
      const workspaceFolders = asArray(ideStateNode.workspace_folders);
      for (const workspaceFolder of workspaceFolders) {
        const folderRecord = asObject(workspaceFolder);
        if (!folderRecord) continue;
        workspaceRoot ||= stringValue(folderRecord.repository_root) ??
          stringValue(folderRecord.folder_root);
      }
      const terminal = asObject(ideStateNode.current_terminal);
      currentWorkingDirectory ||= stringValue(
        terminal?.current_working_directory,
      );
    }
  }

  return {
    informationRequest: requestText ??
      "Provide an overview of this workspace and identify the key files relevant to the user's request.",
    checkpointId: stringValue(blobs.checkpoint_id),
    addedBlobs,
    deletedBlobs,
    workspaceRoot: workspaceRoot ?? currentWorkingDirectory,
    currentWorkingDirectory,
    maxOutputLength: numberValue(body.max_output_length) ?? 0,
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function normalizeWorkspacePrefix(
  path: string,
  workspaceRoot?: string,
): string {
  if (!workspaceRoot) return path;
  const prefix = workspaceRoot.endsWith("/")
    ? workspaceRoot
    : `${workspaceRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function excerpt(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return clip(singleLine, maxChars);
}

function effectiveBlobNames(request: RetrievalRequest): string[] {
  const checkpointBlobs = request.checkpointId
    ? resolveCheckpointBlobNames(request.checkpointId)
    : [];
  const deleted = new Set(request.deletedBlobs);
  const merged = unique([
    ...checkpointBlobs.filter((blob) => !deleted.has(blob)),
    ...request.addedBlobs.filter((blob) => !deleted.has(blob)),
  ]);
  return merged;
}

function deriveQueryVariants(informationRequest: string): string[] {
  const trimmed = informationRequest.trim();
  if (!trimmed) return [];
  const variants = [trimmed];
  const lower = trimmed.toLowerCase();
  if (
    /(todo|fixme|bug|error|incomplete|notimplemented|not implemented|pass\b)/
      .test(lower)
  ) {
    variants.push(
      "TODO FIXME BUG error incomplete implementation NotImplemented pass",
    );
  }
  return unique(variants);
}

function formatRetrieval(
  request: RetrievalRequest,
  blobNames: string[],
  groupedHits: Map<string, ReturnType<typeof makeHitView>[]>,
): string {
  const lines: string[] = [];
  lines.push(`Information request: ${request.informationRequest}`);
  if (request.workspaceRoot) {
    lines.push(`Workspace root: ${request.workspaceRoot}`);
  }
  if (
    request.currentWorkingDirectory &&
    request.currentWorkingDirectory !== request.workspaceRoot
  ) {
    lines.push(`Current working directory: ${request.currentWorkingDirectory}`);
  }
  lines.push(`Indexed blobs considered: ${blobNames.length}`);

  if (groupedHits.size === 0) {
    lines.push("No indexed code chunks matched this request.");
    return lines.join("\n");
  }

  lines.push("Relevant files and excerpts:");
  let ordinal = 1;
  for (const [path, hits] of groupedHits) {
    const bestScore = Math.max(...hits.map((hit) => hit.score));
    lines.push(`${ordinal}. ${path} (best score: ${bestScore.toFixed(4)})`);
    for (const hit of hits.slice(0, 2)) {
      lines.push(`   - chars ${hit.charStart}-${hit.charEnd}: ${hit.preview}`);
    }
    ordinal += 1;
  }

  return lines.join("\n");
}

interface HitView {
  score: number;
  path: string;
  charStart: number;
  charEnd: number;
  preview: string;
}

function makeHitView(hit: {
  score: number;
  path: string;
  charStart: number;
  charEnd: number;
  text: string;
}, workspaceRoot?: string): HitView {
  const relativePath = normalizeWorkspacePrefix(hit.path, workspaceRoot);
  return {
    score: hit.score,
    path: relativePath || hit.path,
    charStart: hit.charStart,
    charEnd: hit.charEnd,
    preview: excerpt(hit.text, 240),
  };
}

export async function handleCodebaseRetrieval(
  config: ProxyConfig,
  ctx: RequestContext,
): Promise<JsonObject> {
  const start = Date.now();
  const request = parseRequest(ctx);
  const blobNames = effectiveBlobNames(request);
  const queryVariants = deriveQueryVariants(request.informationRequest);
  const allHits = [];

  for (const queryText of queryVariants) {
    const hits = await searchIndexedChunks(config, queryText, blobNames, 16);
    allHits.push(...hits);
  }

  const dedupedByLocation = new Map<string, ReturnType<typeof makeHitView>>();
  for (const hit of allHits) {
    const key = `${hit.path}:${hit.charStart}:${hit.charEnd}`;
    const view = makeHitView(hit, request.workspaceRoot);
    const existing = dedupedByLocation.get(key);
    if (!existing || view.score > existing.score) {
      dedupedByLocation.set(key, view);
    }
  }

  const sortedHits = [...dedupedByLocation.values()].sort((a, b) =>
    b.score - a.score
  );
  const groupedHits = new Map<string, ReturnType<typeof makeHitView>[]>();
  for (const hit of sortedHits) {
    const current = groupedHits.get(hit.path) ?? [];
    if (current.length >= 3) continue;
    current.push(hit);
    groupedHits.set(hit.path, current);
    if (
      groupedHits.size >= 8 &&
      [...groupedHits.values()].every((items) => items.length >= 1)
    ) continue;
  }

  let formattedRetrieval = formatRetrieval(request, blobNames, groupedHits);
  if (request.maxOutputLength > 0) {
    formattedRetrieval = clip(formattedRetrieval, request.maxOutputLength);
  }

  logInfo(config, "codebase-retrieval:end", {
    requestId: ctx.requestId,
    query: request.informationRequest,
    blobs: blobNames.length,
    variants: queryVariants.length,
    hits: sortedHits.length,
    files: groupedHits.size,
    chars: formattedRetrieval.length,
    ms: Date.now() - start,
  });

  return {
    formatted_retrieval: formattedRetrieval,
  };
}
