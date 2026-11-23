# Contributing to Protorip Registry Server

`Protorip/registry-server` (`@protorip/registry-server` and `ghcr.io/protorip/registry-server`) is a self-hosted Protobuf module registry compatible with the `buf` CLI.

## Project scope

Before writing code for a new feature, open an issue to check fit. This repository focuses on module hosting (`buf.registry.module.v1`, `buf.registry.owner.v1`, and `buf.alpha.registry.v1alpha1.AuthnService`), local SQLite metadata, local disk or S3-compatible blobs, and declarative static-token authentication.

Hosted workflows such as web schema docs, remote plugins, generated SDKs, `buf.build` dependency proxying, OAuth/SSO, and multi-team RBAC live in [protos.rip](https://protos.rip) and are outside the scope of this repository.

## Development setup

Prerequisites:

- Node.js 24 or later
- Bun 1.4.5 or later
- `pnpm`
- `buf` CLI (matching `v1.50.0` in CI)
- `openssl` (used by local TLS conformance tests)
- Docker (optional, for running the container conformance matrix)

From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm codegen
pnpm typecheck
pnpm test
pnpm test-e2e
```

To also run the container tests against a local image build:

```sh
docker build -t registry-server-conformance .
REGISTRY_TEST_IMAGE=registry-server-conformance pnpm test-e2e
```

## Pull request checklist

- Place direct tests beside the source and run them with `pnpm test`. Keep real Buf CLI and runtime conformance tests under `e2e/`.
- Run `pnpm codegen`, `pnpm typecheck`, `pnpm test`, and `pnpm test-e2e` before opening a pull request.
- Preserve existing copyright and Apache-2.0 headers on vendored definitions under `proto/buf/alpha/registry/v1alpha1/`.
- Contributions submitted to this repository are licensed under Apache-2.0, as described in [LICENSE](./LICENSE).

## Security

Report vulnerabilities privately using the instructions in the [security policy](SECURITY.md).

## Community conduct

Follow the [code of conduct](CODE_OF_CONDUCT.md) when participating in the project.
