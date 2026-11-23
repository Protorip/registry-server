FROM bufbuild/buf:1.50.0 AS buf
FROM oven/bun:1.4.5-slim AS bun-runtime
FROM node:24-bookworm-slim AS build
WORKDIR /registry
COPY --from=buf /usr/local/bin/buf /usr/local/bin/buf
COPY --from=buf /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts
COPY buf.gen.yaml tsconfig.json ./
COPY proto proto
COPY src src
RUN pnpm codegen && bun build --target=bun --external node:sqlite src/server.ts --outfile dist/server.js
RUN bun build --target=bun src/tools/tokens.mts --outfile dist/tools/tokens.mjs
RUN bun build --target=bun --external node:sqlite src/tools/migrate.mts --outfile dist/tools/migrate.mjs

FROM bun-runtime
WORKDIR /registry
COPY --from=build /registry/dist dist
COPY drizzle drizzle
COPY LICENSE NOTICE ./
RUN mkdir /data && chown bun:bun /data
USER bun
ENV PORT=8080 DB_PATH=/data/registry.db FS_ROOT=/data/blobs
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK CMD ["bun", "-e", "try { const response = await fetch('http://127.0.0.1:' + (process.env.PORT?.trim() || 8080) + '/healthz'); process.exit(response.ok && (await response.json()).status === 'ok' ? 0 : 1); } catch { process.exit(1); }"]
ENTRYPOINT ["bun", "/registry/dist/server.js"]
