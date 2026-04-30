import type { JsonObject, JsonValue, ProxyConfig, RequestContext } from "./types.ts";

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

const indexedBlobs = new Set<string>();
const checkpoints = new Map<string, string[]>();
let collectionReady: Promise<void> | undefined;
const pointIdCache = new Map<string, string>();

function bodyObject(ctx: RequestContext): JsonObject {
  return ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body) ? ctx.body : {};
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pointId(input: string): Promise<string> {
  const cached = pointIdCache.get(input);
  if (cached) return cached;
  const hex = await sha256Hex(input);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  pointIdCache.set(input, id);
  return id;
}

function qdrantHeaders(): HeadersInit {
  return { "content-type": "application/json" };
}

async function qdrantRequest(config: ProxyConfig, path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`${config.qdrantUrl}${path}`, {
    ...init,
    headers: { ...qdrantHeaders(), ...(init?.headers ?? {}) },
  });
}


function markerVector(config: ProxyConfig): number[] {
  const vector = new Array(config.embedDimensions).fill(0);
  vector[0] = 1;
  return vector;
}

async function upsertBlobMarker(config: ProxyConfig, blob: UploadBlob): Promise<void> {
  await ensureCollection(config);
  const response = await qdrantRequest(config, `/collections/${encodeURIComponent(config.qdrantCollection)}/points?wait=true`, {
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
  });
  if (!response.ok) throw new Error(`Qdrant marker upsert failed: ${response.status} ${await response.text()}`);
}

async function ensureCollection(config: ProxyConfig): Promise<void> {
  if (collectionReady) return await collectionReady;
  collectionReady = (async () => {
    const collectionPath = `/collections/${encodeURIComponent(config.qdrantCollection)}`;
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
      throw new Error(`Failed to create Qdrant collection: ${created.status} ${await created.text()}`);
    }
  })();
  return await collectionReady;
}

function parseFindMissing(ctx: RequestContext): string[] {
  const body = bodyObject(ctx);
  return Array.isArray(body.mem_object_names)
    ? body.mem_object_names.filter((name): name is string => typeof name === "string")
    : [];
}

function parseUploadBlobs(ctx: RequestContext): UploadBlob[] {
  const body = bodyObject(ctx);
  const blobs = Array.isArray(body.blobs) ? body.blobs : [];
  const output: UploadBlob[] = [];
  for (const blob of blobs) {
    if (!blob || typeof blob !== "object" || Array.isArray(blob)) continue;
    const record = blob as JsonObject;
    if (typeof record.blob_name !== "string" || typeof record.content !== "string") continue;
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

async function embedTexts(config: ProxyConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const headers: HeadersInit = { "content-type": "application/json" };
  if (config.embedApiKey) headers.authorization = `Bearer ${config.embedApiKey}`;
  const response = await fetch(embedUrl(config), {
    method: "POST",
    headers,
    body: JSON.stringify({ model: config.embedModel, input: texts }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Embedding upstream failed: ${response.status} ${raw.slice(0, 1000)}`);
  const data = JSON.parse(raw) as JsonObject;
  const values = Array.isArray(data.data) ? data.data : [];
  return values.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const embedding = (item as JsonObject).embedding;
    return Array.isArray(embedding) ? embedding.filter((n): n is number => typeof n === "number") : [];
  });
}

async function deleteBlobPoints(config: ProxyConfig, blobNames: string[]): Promise<void> {
  if (blobNames.length === 0) return;
  await ensureCollection(config);
  await qdrantRequest(config, `/collections/${encodeURIComponent(config.qdrantCollection)}/points/delete`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        must: [{ key: "blob_name", match: { any: blobNames } }],
      },
    }),
  });
}

async function upsertChunks(config: ProxyConfig, chunks: TextChunk[], embeddings: number[][]): Promise<void> {
  if (chunks.length === 0) return;
  await ensureCollection(config);
  const points = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const vector = embeddings[index];
    if (!vector || vector.length !== config.embedDimensions) {
      throw new Error(`Embedding dimension mismatch for ${chunk.chunkId}: got ${vector?.length ?? 0}, expected ${config.embedDimensions}`);
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
  const response = await qdrantRequest(config, `/collections/${encodeURIComponent(config.qdrantCollection)}/points?wait=true`, {
    method: "PUT",
    body: JSON.stringify({ points }),
  });
  if (!response.ok) throw new Error(`Qdrant upsert failed: ${response.status} ${await response.text()}`);
}


async function existingBlobNames(config: ProxyConfig, names: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  const unknownCandidates = names.filter((name) => !indexedBlobs.has(name));
  for (const name of names) if (indexedBlobs.has(name)) existing.add(name);
  if (unknownCandidates.length === 0) return existing;

  await ensureCollection(config);
  for (let offset = 0; offset < unknownCandidates.length; offset += 128) {
    const batch = unknownCandidates.slice(offset, offset + 128);
    const ids = await Promise.all(batch.map((name) => pointId(`blob-marker:${name}`)));
    const response = await qdrantRequest(config, `/collections/${encodeURIComponent(config.qdrantCollection)}/points`, {
      method: "POST",
      body: JSON.stringify({
        ids,
        with_payload: ["blob_name", "kind"],
        with_vector: false,
      }),
    });
    if (!response.ok) throw new Error(`Qdrant retrieve failed: ${response.status} ${await response.text()}`);
    const data = await response.json() as JsonObject;
    const result = Array.isArray(data.result) ? data.result : [];
    for (const point of result) {
      if (!point || typeof point !== "object" || Array.isArray(point)) continue;
      const payload = (point as JsonObject).payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      const blobName = (payload as JsonObject).blob_name;
      const kind = (payload as JsonObject).kind;
      if (typeof blobName === "string" && kind === "blob_marker") {
        existing.add(blobName);
        indexedBlobs.add(blobName);
      }
    }
  }
  const missingMarkers = unknownCandidates.filter((name) => !existing.has(name));
  for (let offset = 0; offset < missingMarkers.length; offset += 64) {
    const batch = missingMarkers.slice(offset, offset + 64);
    const response = await qdrantRequest(config, `/collections/${encodeURIComponent(config.qdrantCollection)}/points/scroll`, {
      method: "POST",
      body: JSON.stringify({
        limit: batch.length,
        with_payload: ["blob_name"],
        with_vector: false,
        filter: { must: [{ key: "blob_name", match: { any: batch } }] },
      }),
    });
    if (!response.ok) throw new Error(`Qdrant fallback scroll failed: ${response.status} ${await response.text()}`);
    const data = await response.json() as JsonObject;
    const result = data.result && typeof data.result === "object" && !Array.isArray(data.result) ? data.result as JsonObject : {};
    const points = Array.isArray(result.points) ? result.points : [];
    for (const point of points) {
      if (!point || typeof point !== "object" || Array.isArray(point)) continue;
      const payload = (point as JsonObject).payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      const blobName = (payload as JsonObject).blob_name;
      if (typeof blobName === "string") {
        existing.add(blobName);
        indexedBlobs.add(blobName);
      }
    }
  }
  return existing;
}

export async function indexFindMissing(config: ProxyConfig, ctx: RequestContext): Promise<JsonObject> {
  const names = parseFindMissing(ctx);
  if (config.indexingMode === "complete") return { unknown_memory_names: [], nonindexed_blob_names: [] };
  if (config.indexingMode === "capture") return { unknown_memory_names: names, nonindexed_blob_names: [] };
  const existing = await existingBlobNames(config, names);
  for (const name of existing) indexedBlobs.add(name);
  const unknown = names.filter((name) => !existing.has(name) && !indexedBlobs.has(name));
  return { unknown_memory_names: unknown, nonindexed_blob_names: [] };
}

export async function indexBatchUpload(config: ProxyConfig, ctx: RequestContext): Promise<JsonObject> {
  const blobs = parseUploadBlobs(ctx);
  if (config.indexingMode !== "real") {
    return { blob_names: blobs.map((blob) => blob.blobName) };
  }

  const uploaded: string[] = [];
  for (const blob of blobs) {
    await deleteBlobPoints(config, [blob.blobName]);
    const chunks = chunkText(config, blob);
    const embeddings = await embedTexts(config, chunks.map((chunk) => chunk.text));
    await upsertChunks(config, chunks, embeddings);
    await upsertBlobMarker(config, blob);
    indexedBlobs.add(blob.blobName);
    uploaded.push(blob.blobName);
  }
  return { blob_names: uploaded };
}

export async function indexCheckpoint(config: ProxyConfig, ctx: RequestContext): Promise<JsonObject> {
  const body = bodyObject(ctx);
  const blobs = body.blobs && typeof body.blobs === "object" && !Array.isArray(body.blobs) ? body.blobs as JsonObject : {};
  const added = Array.isArray(blobs.added_blobs) ? blobs.added_blobs.filter((name): name is string => typeof name === "string") : [];
  const deleted = Array.isArray(blobs.deleted_blobs) ? blobs.deleted_blobs.filter((name): name is string => typeof name === "string") : [];
  if (config.indexingMode === "real") await deleteBlobPoints(config, deleted);
  for (const name of deleted) indexedBlobs.delete(name);
  for (const name of added) indexedBlobs.add(name);
  const checkpointId = `checkpoint_${crypto.randomUUID()}`;
  checkpoints.set(checkpointId, [...indexedBlobs]);
  return { new_checkpoint_id: checkpointId };
}
