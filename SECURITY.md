# Security policy

## Supported versions

Security fixes are provided for the latest stable release of Protorip Registry Server. If you run an earlier release, plan to upgrade to the latest stable version when a fix is available.

## Report a vulnerability

Submit a private report through [GitHub Security Advisories](https://github.com/Protorip/registry-server/security/advisories/new). If you cannot use GitHub's private reporting form, email [hello@protos.rip](mailto:hello@protos.rip). Keep vulnerability details out of public issues, pull requests, and discussions while the report is under review.

Include enough information for the maintainers to reproduce the issue safely:

- The affected version, image tag or digest, and deployment method.
- Relevant configuration, such as the authentication mode, storage backend, and reverse proxy setup.
- Steps to reproduce the issue on a test instance, the observed behavior, and the potential impact.
- Any known workaround or mitigation.

Remove credentials, tokens, and private schema data from reports and attachments. Test only instances you own or have permission to assess.

Maintainers will review the report privately and coordinate disclosure with you. When a fix is available, the advisory can describe affected versions, the fixed release, and any mitigation operators can apply.

## Run the server safely

For deployments reachable by untrusted clients, use static token authentication or enforce authentication and authorization in the embedding application. Terminate HTTPS at the ingress, keep token configuration private, and restrict access to the SQLite database and blob storage. See the [deployment guide](README.md#docker-deployment).
