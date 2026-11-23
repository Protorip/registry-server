import { createRegistryHandler } from "@protorip/registry-server";
import { sqlite } from "@protorip/registry-server/bun";

const { dbPath, ...config } = JSON.parse(process.env.REGISTRY_TEST_CONFIG);
const registry = createRegistryHandler({ ...config, database: sqlite({ path: dbPath }) });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: registry.fetch });
console.log(JSON.stringify({ event: "listening", port: server.port }));
process.once("SIGTERM", async () => {
  await server.stop();
  await registry.close();
});
