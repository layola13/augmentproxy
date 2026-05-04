import { loadConfigFromEnvFile } from "./config.ts";
import { augmentError } from "./http.ts";
import { parseRequest } from "./http.ts";
import { routeAugment } from "./augment-router.ts";
import { logError, logInfo } from "./logger.ts";

const config = await loadConfigFromEnvFile();
const activeBaseUrl = config.switchApi === "CODEX" ? config.codexBaseUrl : config.openaiBaseUrl;
const activeModel = config.switchApi === "CODEX" ? config.codexModel : config.openaiModel;

console.log(`Augment intercept proxy listening on http://127.0.0.1:${config.port}`);
console.log(`Upstream API: ${config.switchApi}`);
console.log(`Upstream base URL: ${activeBaseUrl}`);
console.log(`Upstream model: ${activeModel}`);
console.log(`Request logs: ${config.requestLogDir}`);

Deno.serve({ port: config.port }, async (request) => {
  try {
    const ctx = await parseRequest(request);
    const start = Date.now();
    logInfo(config, "request:start", { requestId: ctx.requestId, method: ctx.method, path: ctx.path });
    const response = await routeAugment(config, ctx);
    logInfo(config, "request:end", { requestId: ctx.requestId, method: ctx.method, path: ctx.path, status: response.status, ms: Date.now() - start });
    return response;
  } catch (error) {
    logError(config, "request:error", { error: error instanceof Error ? error.message : String(error) });
    return augmentError(error instanceof Error ? error.message : String(error), 500, "proxy_error");
  }
});
