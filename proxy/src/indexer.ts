import type {
  JsonObject,
  JsonValue,
  ProxyConfig,
  RequestContext,
} from "./types.ts";
import { logInfo } from "./logger.ts";

interface UploadBlob {
  blobName: string;
  path: string;
  content: string;
}

interface TextChunk {
  chunkId: string;
  blobName: string;
  path: string;
  index: number;
  charStart: number;
  charEnd: number;
  text: string;
}

export interface IndexedChunkHit {
  score: number;
  blobName: string;
  path: string;
  chunkIndex: number;
  charStart: number;
  charEnd: number;
  text: string;
}

const indexedBlobs = new Set<string>();
const checkpoints = new Map<string, string[]>();
const seenUploads = new Map<
  string,
  { path: string; contentLength: number; seenAt: string }
>();
const pendingUploads = new Map<
  string,
  {
    path: string;
    contentLength: number;
    startedAt: string;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  }
>();
let collectionReady: Promise<void> | undefined;
const pointIdCache = new Map<string, string>();

function createPendingUpload(blob: UploadBlob): void {
  if (pendingUploads.has(blob.blobName)) return;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  pendingUploads.set(blob.blobName, {
    path: blob.path,
    contentLength: blob.content.length,
    startedAt: new Date().toISOString(),
    promise,
    resolve,
    reject,
  });
}

async function waitForPendingUploads(
  config: ProxyConfig,
  requestId: string,
  names: string[],
): Promise<void> {
  const pending = names
    .map((name) => ({ name, upload: pendingUploads.get(name) }))
    .filter((entry): entry is {
      name: string;
      upload: NonNullable<ReturnType<typeof pendingUploads.get>>;
    } => Boolean(entry.upload));
  if (pending.length === 0) return;

  logInfo(config, "index:find-missing:wait-pending", {
    requestId,
    pending: pending.length,
    samples: pending.slice(0, 20).map(({ name, upload }) => ({
      name,
      path: upload.path,
      contentLength: upload.contentLength,
      startedAt: upload.startedAt,
    })),
  });

  const timeoutMs = 180_000;
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
  await Promise.race([
    Promise.allSettled(pending.map(({ upload }) => upload.promise)).then(() =>
      undefined
    ),
    timeout,
  ]);
}

function bodyObject(ctx: RequestContext): JsonObject {
  return ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)
    ? ctx.body
    : {};
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function pointId(input: string): Promise<string> {
  const cached = pointIdCache.get(input);
  if (cached) return cached;
  const hex = await sha256Hex(input);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20, 32)}`;
  pointIdCache.set(input, id);
  return id;
}

function qdrantHeaders(): HeadersInit {
  return { "content-type": "application/json" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function qdrantRequest(
  config: ProxyConfig,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${config.qdrantUrl}${path}`, {
        ...init,
        headers: { ...qdrantHeaders(), ...(init?.headers ?? {}) },
      });
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new Error(
        `Qdrant HTTP ${response.status}: ${await response.text().catch(() =>
          ""
        )}`,
      );
    } catch (error) {
      lastError = error;
    }
    await sleep(150 * 2 ** attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function markerVector(config: ProxyConfig): number[] {
  const vector = new Array(config.embedDimensions).fill(0);
  vector[0] = 1;
  return vector;
}

async function upsertBlobMarker(
  config: ProxyConfig,
  blob: UploadBlob,
): Promise<void> {
  await ensureCollection(config);
  const response = await qdrantRequest(
    config,
    `/collections/${
      encodeURIComponent(config.qdrantCollection)
    }/points?wait=true`,
    {
      method: "PUT",
      body: JSON.stringify({
        points: [{
          id: await pointId(`blob-marker:${blob.blobName}`),
          vector: markerVector(config),
          payload: {
            kind: "blob_marker",
            blob_name: blob.blobName,
            path: blob.path,
            content_length: blob.content.length,
            indexed_at: new Date().toISOString(),
          },
        }],
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Qdrant marker upsert failed: ${response.status} ${await response
        .text()}`,
    );
  }
}

async function upsertOrphanBlobMarkers(
  config: ProxyConfig,
  blobNames: string[],
): Promise<void> {
  if (blobNames.length === 0) return;
  await ensureCollection(config);
  const points = [];
  for (const blobName of blobNames) {
    points.push({
      id: await pointId(`blob-marker:${blobName}`),
      vector: markerVector(config),
      payload: {
        kind: "blob_marker",
        blob_name: blobName,
        path: "",
        content_length: 0,
        orphan: true,
        indexed_at: new Date().toISOString(),
      },
    });
  }
  const response = await qdrantRequest(
    config,
    `/collections/${
      encodeURIComponent(config.qdrantCollection)
    }/points?wait=true`,
    {
      method: "PUT",
      body: JSON.stringify({ points }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Qdrant orphan marker upsert failed: ${response.status} ${await response
        .text()}`,
    );
  }
}

async function ensureCollection(config: ProxyConfig): Promise<void> {
  if (collectionReady) return await collectionReady;
  collectionReady = (async () => {
    const collectionPath = `/collections/${
      encodeURIComponent(config.qdrantCollection)
    }`;
    const existing = await qdrantRequest(config, collectionPath);
    if (existing.ok) return;
    const created = await qdrantRequest(config, collectionPath, {
      method: "PUT",
      body: JSON.stringify({
        vectors: {
          size: config.embedDimensions,
          distance: "Cosine",
        },
      }),
    });
    if (!created.ok) {
      throw new Error(
        `Failed to create Qdrant collection: ${created.status} ${await created
          .text()}`,
      );
    }
  })();
  return await collectionReady;
}

function parseFindMissing(ctx: RequestContext): string[] {
  const body = bodyObject(ctx);
  return Array.isArray(body.mem_object_names)
    ? body.mem_object_names.filter((name): name is string =>
      typeof name === "string"
    )
    : [];
}

function parseUploadBlobs(ctx: RequestContext): UploadBlob[] {
  const body = bodyObject(ctx);
  const blobs = Array.isArray(body.blobs) ? body.blobs : [];
  const output: UploadBlob[] = [];
  for (const blob of blobs) {
    if (!blob || typeof blob !== "object" || Array.isArray(blob)) continue;
    const record = blob as JsonObject;
    if (
      typeof record.blob_name !== "string" || typeof record.content !== "string"
    ) continue;
    output.push({
      blobName: record.blob_name,
      path: typeof record.path === "string" ? record.path : "",
      content: record.content,
    });
  }
  return output;
}

function chunkText(config: ProxyConfig, blob: UploadBlob): TextChunk[] {
  const size = Math.max(200, config.indexChunkChars);
  const overlap = Math.max(0, Math.min(config.indexChunkOverlap, size - 1));
  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < blob.content.length) {
    const end = Math.min(blob.content.length, start + size);
    const text = blob.content.slice(start, end);
    if (text.trim()) {
      chunks.push({
        chunkId: `${blob.blobName}:${index}`,
        blobName: blob.blobName,
        path: blob.path,
        index,
        charStart: start,
        charEnd: end,
        text,
      });
    }
    if (end >= blob.content.length) break;
    start = end - overlap;
    index += 1;
  }
  return chunks;
}

function embedUrl(config: ProxyConfig): string {
  return `${config.embedBaseUrl}/embeddings`;
}

async function embedTexts(
  config: ProxyConfig,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const headers: HeadersInit = { "content-type": "application/json" };
  if (config.embedApiKey) {
    headers.authorization = `Bearer ${config.embedApiKey}`;
  }
  const response = await fetch(embedUrl(config), {
    method: "POST",
    headers,
    body: JSON.stringify({ model: config.embedModel, input: texts }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Embedding upstream failed: ${response.status} ${raw.slice(0, 1000)}`,
    );
  }
  const data = JSON.parse(raw) as JsonObject;
  const values = Array.isArray(data.data) ? data.data : [];
  return values.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const embedding = (item as JsonObject).embedding;
    return Array.isArray(embedding)
      ? embedding.filter((n): n is number => typeof n === "number")
      : [];
  });
}

async function deleteBlobPoints(
  config: ProxyConfig,
  blobNames: string[],
): Promise<void> {
  if (blobNames.length === 0) return;
  await ensureCollection(config);
  await qdrantRequest(
    config,
    `/collections/${encodeURIComponent(config.qdrantCollection)}/points/delete`,
    {
      method: "POST",
      body: JSON.stringify({
        filter: {
          must: [{ key: "blob_name", match: { any: blobNames } }],
        },
      }),
    },
  );
}

async function upsertChunks(
  config: ProxyConfig,
  chunks: TextChunk[],
  embeddings: number[][],
): Promise<void> {
  if (chunks.length === 0) return;
  await ensureCollection(config);
  const points = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const vector = embeddings[index];
    if (!vector || vector.length !== config.embedDimensions) {
      throw new Error(
        `Embedding dimension mismatch for ${chunk.chunkId}: got ${
          vector?.length ?? 0
        }, expected ${config.embedDimensions}`,
      );
    }
    points.push({
      id: await pointId(chunk.chunkId),
      vector,
      payload: {
        kind: "chunk",
        blob_name: chunk.blobName,
        path: chunk.path,
        chunk_index: chunk.index,
        char_start: chunk.charStart,
        char_end: chunk.charEnd,
        text: chunk.text,
      },
    });
  }

  for (let offset = 0; offset < points.length; offset += 16) {
    const batch = points.slice(offset, offset + 16);
    const response = await qdrantRequest(
      config,
      `/collections/${
        encodeURIComponent(config.qdrantCollection)
      }/points?wait=true`,
      {
        method: "PUT",
        body: JSON.stringify({ points: batch }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Qdrant upsert failed: ${response.status} ${await response.text()}`,
      );
    }
  }
}

async function existingBlobNames(
  config: ProxyConfig,
  names: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  const unknownCandidates = names.filter((name) => !indexedBlobs.has(name));
  for (const name of names) if (indexedBlobs.has(name)) existing.add(name);
  if (unknownCandidates.length === 0) return existing;

  await ensureCollection(config);
  for (let offset = 0; offset < unknownCandidates.length; offset += 128) {
    const batch = unknownCandidates.slice(offset, offset + 128);
    const ids = await Promise.all(
      batch.map((name) => pointId(`blob-marker:${name}`)),
    );
    const response = await qdrantRequest(
      config,
      `/collections/${encodeURIComponent(config.qdrantCollection)}/points`,
      {
        method: "POST",
        body: JSON.stringify({
          ids,
          with_payload: ["blob_name", "kind"],
          with_vector: false,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Qdrant retrieve failed: ${response.status} ${await response.text()}`,
      );
    }
    const data = await response.json() as JsonObject;
    const result = Array.isArray(data.result) ? data.result : [];
    for (const point of result) {
      if (!point || typeof point !== "object" || Array.isArray(point)) continue;
      const payload = (point as JsonObject).payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        continue;
      }
      const blobName = (payload as JsonObject).blob_name;
      const kind = (payload as JsonObject).kind;
      if (typeof blobName === "string" && kind === "blob_marker") {
        existing.add(blobName);
        indexedBlobs.add(blobName);
      }
    }
  }
  const missingMarkers = unknownCandidates.filter((name) =>
    !existing.has(name)
  );
  for (let offset = 0; offset < missingMarkers.length; offset += 64) {
    const batch = missingMarkers.slice(offset, offset + 64);
    const response = await qdrantRequest(
      config,
      `/collections/${
        encodeURIComponent(config.qdrantCollection)
      }/points/scroll`,
      {
        method: "POST",
        body: JSON.stringify({
          limit: batch.length,
          with_payload: ["blob_name"],
          with_vector: false,
          filter: { must: [{ key: "blob_name", match: { any: batch } }] },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Qdrant fallback scroll failed: ${response.status} ${await response
          .text()}`,
      );
    }
    const data = await response.json() as JsonObject;
    const result = data.result && typeof data.result === "object" &&
        !Array.isArray(data.result)
      ? data.result as JsonObject
      : {};
    const points = Array.isArray(result.points) ? result.points : [];
    for (const point of points) {
      if (!point || typeof point !== "object" || Array.isArray(point)) continue;
      const payload = (point as JsonObject).payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        continue;
      }
      const blobName = (payload as JsonObject).blob_name;
      if (typeof blobName === "string") {
        existing.add(blobName);
        indexedBlobs.add(blobName);
      }
    }
  }
  return existing;
}

export async function indexFindMissing(
  config: ProxyConfig,
  ctx: RequestContext,
): Promise<JsonObject> {
  const start = Date.now();
  const names = parseFindMissing(ctx);
  logInfo(config, "index:find-missing:start", {
    requestId: ctx.requestId,
    names: names.length,
  });
  if (config.indexingMode === "complete") {
    return { unknown_memory_names: [], nonindexed_blob_names: [] };
  }
  if (config.indexingMode === "capture") {
    return { unknown_memory_names: names, nonindexed_blob_names: [] };
  }
  await waitForPendingUploads(config, ctx.requestId, names);
  const existing = await existingBlobNames(config, names);
  for (const name of existing) indexedBlobs.add(name);
  const unknown = names.filter((name) =>
    !existing.has(name) && !indexedBlobs.has(name)
  );
  const unknownSamples = unknown.slice(0, 20);
  const orphanUnknown = unknown.filter((name) =>
    !seenUploads.has(name) && !pendingUploads.has(name)
  );
  if (orphanUnknown.length > 0) {
    await upsertOrphanBlobMarkers(config, orphanUnknown);
    for (const name of orphanUnknown) indexedBlobs.add(name);
    logInfo(config, "index:find-missing:orphan-markers", {
      requestId: ctx.requestId,
      count: orphanUnknown.length,
      samples: orphanUnknown.slice(0, 20),
    });
  }
  const returnedUnknown = unknown.filter((name) => !orphanUnknown.includes(name));
  logInfo(config, "index:find-missing:end", {
    requestId: ctx.requestId,
    names: names.length,
    existing: existing.size,
    unknown: returnedUnknown.length,
    orphanUnknown: orphanUnknown.length,
    unknownSamples,
    seenUploads: unknownSamples.map((name) => ({
      name,
      upload: seenUploads.get(name) ?? null,
    })),
    ms: Date.now() - start,
  });
  return { unknown_memory_names: returnedUnknown, nonindexed_blob_names: [] };
}

export async function indexBatchUpload(
  config: ProxyConfig,
  ctx: RequestContext,
): Promise<JsonObject> {
  const start = Date.now();
  const blobs = parseUploadBlobs(ctx);
  logInfo(config, "index:batch-upload:start", {
    requestId: ctx.requestId,
    blobs: blobs.length,
  });
  if (config.indexingMode !== "real") {
    return { blob_names: blobs.map((blob) => blob.blobName) };
  }

  for (const blob of blobs) createPendingUpload(blob);

  const uploaded: string[] = [];
  for (const blob of blobs) {
    const pending = pendingUploads.get(blob.blobName);
    try {
      seenUploads.set(blob.blobName, {
        path: blob.path,
        contentLength: blob.content.length,
        seenAt: new Date().toISOString(),
      });
      await deleteBlobPoints(config, [blob.blobName]);
      const chunks = chunkText(config, blob);
      const embeddings = await embedTexts(
        config,
        chunks.map((chunk) => chunk.text),
      );
      await upsertChunks(config, chunks, embeddings);
      await upsertBlobMarker(config, blob);
      indexedBlobs.add(blob.blobName);
      uploaded.push(blob.blobName);
      pending?.resolve();
    } catch (error) {
      pending?.reject(error);
      throw error;
    } finally {
      pendingUploads.delete(blob.blobName);
    }
  }
  logInfo(config, "index:batch-upload:end", {
    requestId: ctx.requestId,
    blobs: uploaded.length,
    ms: Date.now() - start,
  });
  return { blob_names: uploaded };
}

export async function indexCheckpoint(
  config: ProxyConfig,
  ctx: RequestContext,
): Promise<JsonObject> {
  const body = bodyObject(ctx);
  const blobs =
    body.blobs && typeof body.blobs === "object" && !Array.isArray(body.blobs)
      ? body.blobs as JsonObject
      : {};
  const added = Array.isArray(blobs.added_blobs)
    ? blobs.added_blobs.filter((name): name is string =>
      typeof name === "string"
    )
    : [];
  const deleted = Array.isArray(blobs.deleted_blobs)
    ? blobs.deleted_blobs.filter((name): name is string =>
      typeof name === "string"
    )
    : [];
  if (config.indexingMode === "real") await deleteBlobPoints(config, deleted);
  for (const name of deleted) indexedBlobs.delete(name);
  for (const name of added) indexedBlobs.add(name);
  const checkpointId = `checkpoint_${crypto.randomUUID()}`;
  checkpoints.set(checkpointId, [...indexedBlobs]);
  return { new_checkpoint_id: checkpointId };
}

export function resolveCheckpointBlobNames(checkpointId: string): string[] {
  return checkpoints.get(checkpointId) ?? [];
}

export async function searchIndexedChunks(
  config: ProxyConfig,
  queryText: string,
  blobNames: string[],
  limit = 12,
): Promise<IndexedChunkHit[]> {
  const trimmedQuery = queryText.trim();
  if (!trimmedQuery) return [];

  const embeddings = await embedTexts(config, [trimmedQuery]);
  const vector = embeddings[0];
  if (!vector || vector.length !== config.embedDimensions) {
    throw new Error(
      `Query embedding dimension mismatch: got ${
        vector?.length ?? 0
      }, expected ${config.embedDimensions}`,
    );
  }

  const must: JsonObject[] = [{ key: "kind", match: { value: "chunk" } }];
  if (blobNames.length > 0) {
    must.push({ key: "blob_name", match: { any: blobNames } });
  }
  const filter = { must };

  const payloadFields = [
    "blob_name",
    "path",
    "chunk_index",
    "char_start",
    "char_end",
    "text",
    "kind",
  ];
  const collectionPath = `/collections/${
    encodeURIComponent(config.qdrantCollection)
  }`;
  const legacySearchBody = {
    vector,
    limit,
    with_payload: payloadFields,
    with_vector: false,
    filter,
  };
  const querySearchBody = {
    query: vector,
    limit,
    with_payload: payloadFields,
    with_vector: false,
    filter,
  };

  let response = await qdrantRequest(
    config,
    `${collectionPath}/points/search`,
    {
      method: "POST",
      body: JSON.stringify(legacySearchBody),
    },
  );
  if (response.status === 404) {
    response = await qdrantRequest(config, `${collectionPath}/points/query`, {
      method: "POST",
      body: JSON.stringify(querySearchBody),
    });
  }
  if (!response.ok) {
    throw new Error(
      `Qdrant search failed: ${response.status} ${await response.text()}`,
    );
  }

  const data = await response.json() as JsonObject;
  const result = Array.isArray(data.result)
    ? data.result
    : data.result && typeof data.result === "object" &&
        !Array.isArray(data.result)
    ? Array.isArray((data.result as JsonObject).points)
      ? (data.result as JsonObject).points as JsonValue[]
      : []
    : [];

  const hits: IndexedChunkHit[] = [];
  for (const item of result) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as JsonObject;
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }
    const payloadRecord = payload as JsonObject;
    const text = typeof payloadRecord.text === "string"
      ? payloadRecord.text
      : "";
    if (!text.trim()) continue;
    hits.push({
      score: typeof record.score === "number" ? record.score : 0,
      blobName: typeof payloadRecord.blob_name === "string"
        ? payloadRecord.blob_name
        : "",
      path: typeof payloadRecord.path === "string" ? payloadRecord.path : "",
      chunkIndex: typeof payloadRecord.chunk_index === "number"
        ? payloadRecord.chunk_index
        : 0,
      charStart: typeof payloadRecord.char_start === "number"
        ? payloadRecord.char_start
        : 0,
      charEnd: typeof payloadRecord.char_end === "number"
        ? payloadRecord.char_end
        : 0,
      text,
    });
  }
  return hits;
}
