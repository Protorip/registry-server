<p>
  <a href="https://protos.rip">
    <img src="https://protos.rip/logo-oss.svg" alt="Protorip Registry Server" width="56" />
  </a>
</p>

# Protorip Registry Server

Protorip Registry Server is an open-source, self-hostable Protocol Buffers schema registry. It implements the module management APIs defined by the [registry-proto spec](https://github.com/bufbuild/registry-proto) used by [Buf Schema Registry (buf.build)](https://buf.build/), so you can publish, version, and consume modules with the [Buf CLI](https://buf.build/docs/cli/) you already use.

You can deploy the registry as a self-contained Docker image, run the server directly with Node.js or Bun, or embed it in your own application to integrate your application's authentication.

> Protorip Registry Server is developed and maintained by the team behind [protos.rip](https://protos.rip) - the low cost alternative to Buf Schema Registry.

## Compatibility

Protorip Registry Server implements the BSR protocol for core Buf CLI workflows. The automated [conformance suite](#conformance-tests) verifies login, module push and pull, label management, schema export, dependency resolution, and breaking-change checks against remote schemas. The suite also verifies runtime and storage parity.

If you want a managed registry with public module mirrors, remote plugins, and automatically generated schema docs, see [protos.rip](https://protos.rip).

| Capability                                                 | Protorip Registry Server                      | [protos.rip](https://protos.rip)                                          | [buf.build](https://buf.build/)                                                                         |
| ---------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Publish, version, and consume modules                      | Yes                                           | Yes                                                                       | Yes                                                                                                     |
| Use core public modules such as `googleapis/googleapis`    | Publish dependencies to your registry first   | [Available at matching module paths](https://protos.rip/registry)         | [Available at matching module paths](https://buf.build/googleapis/googleapis)                           |
| Generate code with remote plugins                          | No hosted plugins                             | Supported                                                                 | Supported                                                                                               |
| Install generated SDKs from package feeds                  | No                                            | npm, Go                                                                   | [npm, Go, Cargo, CMake, Maven/Gradle, NuGet, Python, Swift](https://buf.build/docs/bsr/generated-sdks/) |
| Manage organization members and assign module-level roles  | Static token roles with optional owner scopes | [Supported](https://protos.rip/blog/teams-module-roles-and-scoped-tokens) | [Supported](https://buf.build/docs/bsr/admin/roles/)                                                    |
| Browse modules and automatically generated docs on the web | No                                            | Yes                                                                       | Yes                                                                                                     |
| Enforce lint and breaking-change rules on the server       | No                                            | No                                                                        | [Enterprise schema checks](https://buf.build/docs/bsr/checks/)                                          |

Run one registry process per SQLite file and blob namespace.

## Runtimes and prerequisites

| Deployment      | Requirements                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Docker          | Docker, `curl` (optional, for health checks), and a persistent volume for SQLite and any filesystem blobs. The image includes Bun. |
| Direct server   | Node.js 24 or later, or Bun 1.4.5 or later.                                                                                        |
| Embedded server | Node.js 24 or later with the Node SQLite adapter, or Bun 1.4.5 or later with the Bun SQLite adapter.                               |
| Client          | [Buf CLI](https://buf.build/docs/installation) to push, pull, and manage modules.                                                  |

## Local evaluation

Run Docker and the Buf CLI on the same machine.

```sh
docker pull ghcr.io/protorip/registry-server:latest
# To build from source instead: docker build -t ghcr.io/protorip/registry-server:latest .
```

### Generate an operator token

```sh
docker run --rm --entrypoint bun ghcr.io/protorip/registry-server:latest /registry/dist/tools/tokens.mjs --name operator

# Give the first line (the client secret) to Buf.
export REGISTRY_TOKEN='<line-1-psr-secret>'
# Give the second line (the hashed entry) to the server.
export REGISTRY_TOKENS='<line-2-operator-sha256-entry>'
```

### Start the registry

```sh
# Bind to loopback. The server runs migrations on startup.
docker run -d --name protorip-registry-eval \
  -p 127.0.0.1:8080:8080 \
  -v protorip-registry-eval-data:/data \
  -e TOKENS="$REGISTRY_TOKENS" \
  ghcr.io/protorip/registry-server:latest

# Expect HTTP 200 when SQLite responds, or 503 if it fails or the server is shutting down.
curl --fail http://127.0.0.1:8080/healthz
```

### Connect to the local registry with Buf

```sh
# Allow plain HTTP in a separate Buf configuration for this local test.
mkdir -p .tmp-buf
cat > .tmp-buf/config.yaml <<'EOF'
version: v1
tls:
  use: "false"
EOF

BUF_CONFIG_DIR=.tmp-buf BUF_TOKEN="${REGISTRY_TOKEN}@127.0.0.1:8080" \
  buf registry whoami 127.0.0.1:8080

BUF_CONFIG_DIR=.tmp-buf BUF_TOKEN="${REGISTRY_TOKEN}@127.0.0.1:8080" \
  buf registry module create 127.0.0.1:8080/team/widgets
```

To push a module, set its `name` in `buf.yaml` to match the registry host (for example, `127.0.0.1:8080/team/widgets`). See [Buf module configuration](https://buf.build/docs/configuration/v2/buf-yaml/) for `buf.yaml` details.

When you finish evaluating, remove the temporary config, container, and volume:

```sh
rm -rf .tmp-buf
docker stop protorip-registry-eval
docker rm protorip-registry-eval
docker volume rm protorip-registry-eval-data
```

## Docker deployment

Use the published `ghcr.io/protorip/registry-server` image, or build the image from this repository and push it to a container registry your deployment can pull from.

[Generate a token](#generate-an-operator-token) and use its hashed entry for `TOKENS`. See [server configuration](#server-configuration) for file-based tokens.

```sh
# Terminate HTTPS at your proxy, forward to 127.0.0.1:8080, and check /healthz.
# The named volume holds SQLite and filesystem blobs.
docker run -d --name protorip-registry \
  -p 127.0.0.1:8080:8080 \
  -v protorip-registry-data:/data \
  -e TOKENS="$REGISTRY_TOKENS" \
  ghcr.io/protorip/registry-server:latest
```

If you bind-mount a host directory at `/data`, give the container's `bun` user write access.

### Applying migrations manually

```sh
# With the server stopped, mount its data volume. The image sets DB_PATH=/data/registry.db.
docker run --rm --entrypoint bun -v protorip-registry-data:/data \
  ghcr.io/protorip/registry-server:latest /registry/dist/tools/migrate.mjs
```

### S3-compatible blob storage

To store commit files in S3 instead of on disk, provision a bucket and set the bucket, region, and endpoint for your provider. SQLite still requires a persistent volume at `/data`. If your provider uses static credentials, export `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN` in your shell so Docker passes them through.

```sh
docker run -d --name protorip-registry-s3 \
  -p 127.0.0.1:8081:8080 \
  -v protorip-registry-s3-data:/data \
  -e TOKENS="$REGISTRY_TOKENS" \
  -e STORAGE_BACKEND=s3 \
  -e S3_BUCKET=registry-blobs \
  -e S3_REGION=us-east-1 \
  -e S3_ENDPOINT=https://s3.example.com \
  -e S3_FORCE_PATH_STYLE=true \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  ghcr.io/protorip/registry-server:latest
```

To use AWS S3 directly, omit `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE`. If you expose this container through HTTPS ingress, forward requests to its host port (`8081` in this example).

### Buf connections over HTTPS

Set `BUF_TOKEN` for your registry's HTTPS hostname (or run `buf registry login <hostname>`):

```sh
REGISTRY_HOST=registry.example.com
export BUF_TOKEN="${REGISTRY_TOKEN}@${REGISTRY_HOST}"
buf registry whoami "$REGISTRY_HOST"
buf registry module create "$REGISTRY_HOST/team/widgets"
```

Use the same hostname in your `buf.yaml` module names before running `buf push`. Push dependencies to the same registry before uploading modules that use them.

## Node.js and Bun integration

### Embedding the registry in an application

The example uses `hono` and `@hono/node-server`.

```js
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createRegistryHandler } from "@protorip/registry-server";
import { sqlite } from "@protorip/registry-server/node"; // Use /bun on Bun.

// sqlite() applies migrations on open.
const database = sqlite({ path: "./data/registry.db" });
const registry = createRegistryHandler({
  database,
  storage: { type: "fs", rootDir: "./data/blobs" },
  auth: { mode: "static", tokensFile: "./registry-tokens.txt" },
});

const app = new Hono();

app.all("/buf.*", (c) => registry.fetch(c.req.raw));
app.get("/healthz", (c) => registry.fetch(c.req.raw));

// On Bun, use Bun.serve({ fetch: app.fetch, port: 8080 }).
const server = serve({ fetch: app.fetch, port: 8080 });
// Drain requests and close the database on shutdown.
process.once("SIGTERM", () => server.close(() => void registry.close()));
```

Create `registry-tokens.txt` with a hashed entry from [the token tool](#generate-an-operator-token) before starting the application. If handler construction throws, close the adapter directly.

If your application manages authentication, mount its authentication and authorization middleware on `/buf.*` before forwarding RPCs. Use `auth: { mode: "none" }` only when that middleware enforces the permissions needed for each operation.

### Application-managed Drizzle connections

```js
import { DatabaseSync } from "node:sqlite";
import { migrate } from "@protorip/registry-server";
import { drizzleNode } from "@protorip/registry-server/node";

const client = new DatabaseSync("./app.db");
client.exec("PRAGMA foreign_keys = ON"); // Enforce foreign keys on this connection.
const db = drizzleNode(client);
migrate(db); // Apply pending migrations before serving requests.

// Pass database to createRegistryHandler. The host application closes the client.
const database = { db, close() {} };
```

> **TypeScript note.** Install `@types/node` and include `node` if your TypeScript config restricts ambient types. Set `skipLibCheck: true` to skip declaration errors in Drizzle ORM 0.45.x, including declarations that reference optional database drivers.

### Running the server directly

After [building the package](#building-the-package-from-source), you can run these commands with Node.js or Bun.

```sh
# Optional before startup. Without --db, the tool uses DB_PATH or ./data/registry.db.
node dist/tools/migrate.mjs --db ./data/registry.db

node dist/tools/tokens.mjs --name operator
# Save the second line in registry-tokens.txt, then start the server.
TOKENS_FILE=./registry-tokens.txt node dist/server.js
```

## Server configuration

| Variable                                   | Default or behavior                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                     | `8080`                                                                                                                                                                    |
| `DB_PATH`                                  | `./data/registry.db` from the working directory, or `/data/registry.db` in Docker.                                                                                        |
| `STORAGE_BACKEND`                          | `fs`. Set to `s3` to use object storage.                                                                                                                                  |
| `FS_ROOT`                                  | `./data/blobs` from the working directory, or `/data/blobs` in Docker.                                                                                                    |
| `S3_BUCKET`                                | Required for S3 storage. Create the bucket before starting the registry.                                                                                                  |
| `S3_REGION`, `S3_ENDPOINT`, `S3_PREFIX`    | AWS region, optional custom endpoint, and optional key prefix                                                                                                             |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Optional S3 credential pair. When omitted, the AWS SDK uses its standard credential chain.                                                                                |
| `S3_FORCE_PATH_STYLE`                      | `false`. Set to `true` if your S3 endpoint requires path-style URLs.                                                                                                      |
| `AUTH_MODE`                                | `static`, which requires at least one valid token. Use `none` for a trusted network or when your host server authenticates all requests.                                  |
| `TOKENS`, `TOKENS_FILE`                    | A JSON array or entries of the form `name:sha256:<hex>[:role]`. Separate inline entries with commas and file entries with newlines. A file reloads on change or `SIGHUP`. |
| `ALLOW_PUBLIC_MODULES`                     | `false` in static mode. Enable to allow public visibility and anonymous pulls for public modules.                                                                         |
| `ALLOWED_SCOPES`                           | Optional comma-separated list of owners that can be used when creating modules                                                                                            |
| `LOG_LEVEL`                                | `info`. Set to `debug`, `info`, `warn`, or `error`.                                                                                                                       |

A `read` token can pull modules. A `write` token can also push and manage labels. An `admin` token can also create, update, and delete modules. Tokens default to `admin`. To restrict a token to particular owner names, give the JSON entry a `scopes` array.

### Token configuration format

```sh
# Join the hashed entries from tokens.mjs with commas.
export TOKENS='operator:sha256:<hex>:admin,ci-reader:sha256:<hex>:read'
```

For file-based configuration, put one entry per line in `registry-tokens.txt` and point `TOKENS_FILE` to it (in Docker, mount the file and set `TOKENS_FILE` to its path inside the container):

```text
operator:sha256:<hex>:admin
ci-reader:sha256:<hex>:read
```

## Building the package from source

Install dependencies and generate protocol bindings with Buf available on `PATH`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm codegen
pnpm build
```

### Adding migrations

Update `src/schema.ts`, then run Drizzle Kit 0.31 from the package directory.

```sh
drizzle-kit generate --dialect sqlite --schema ./src/schema.ts --out ./drizzle --name describe_change
```

Commit the new numbered SQL file, the updated `drizzle/meta/_journal.json`, and the new snapshot in `drizzle/meta/`. Keep applied migration SQL intact. The initial migration is `drizzle/0000_initial.sql`.

Review the generated SQL for SQLite constraints that need manual edits, including `STRICT` and `DEFERRABLE INITIALLY DEFERRED`. Separate multiple statements with `--> statement-breakpoint`.

## Conformance tests

With `buf`, `bun`, and `openssl` on `PATH`, generate the bindings and run the suite.

```sh
pnpm codegen
pnpm test:conformance

# Optional on Linux. Include the Docker runtime in the same suite.
docker build -t registry-server-conformance .
REGISTRY_TEST_IMAGE=registry-server-conformance pnpm test:conformance
```

- The [Buf CLI tests](e2e/cli.test.mjs) verify BSR protocol compatibility through real CLI workflows.
- The [runtime matrix](e2e/runtime-matrix.test.mjs) runs registry workflows against embedded Node.js and Bun handlers and the standalone Bun server. Each runs with `none` and `static` auth and with filesystem storage and an S3 emulator.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Copyright 2026 Strange Computer (Marc Porciuncula).

`Protorip`, `protos.rip`, and the Protorip logo are trademarks of Strange Computer (Marc Porciuncula). Protorip Registry Server is an independent project by Strange Computer and is not affiliated with or endorsed by Buf Technologies, Inc.
