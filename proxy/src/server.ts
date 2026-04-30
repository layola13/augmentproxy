import { loadConfigFromEnvFile } from "./config.ts";
import { augmentError } from "./http.ts";
import { parseRequest } from "./http.ts";
import { routeAugment } from "./augment-router.ts";

const config = await loadConfigFromEnvFile();

console.log(`Augment intercept proxy listening on http://127.0.0.1:${config.port}`);
console.log(`OpenAI upstream: ${config.openaiBaseUrl}`);
console.log(`OpenAI model: ${config.openaiModel}`);
console.log(`Request logs: ${config.requestLogDir}`);

Deno.serve({ port: config.port }, async (request) => {
  try {
    const ctx = await parseRequest(request);
    return await routeAugment(config, ctx);
  } catch (error) {
    console.error(error);
    return augmentError(error instanceof Error ? error.message : String(error), 500, "proxy_error");
  }
});
