import { createRegistryHandler, type RegistryConfig } from "@protorip/registry-server";
import { sqlite } from "@protorip/registry-server/bun";

const rawConfig = process.env.REGISTRY_TEST_CONFIG;
if (!rawConfig) throw new Error("REGISTRY_TEST_CONFIG must be set for embedded Bun tests");
const { dbPath, ...config } = JSON.parse(rawConfig) as Pick<RegistryConfig, "auth" | "storage"> & {
  dbPath: string;
};
const registry = createRegistryHandler({ ...config, database: sqlite({ path: dbPath }) });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: registry.fetch });
console.log(JSON.stringify({ event: "listening", port: server.port }));
process.once("SIGTERM", async () => {
  await server.stop();
  await registry.close();
});
