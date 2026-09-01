# Security policy

## Supported scope

The supported public source baseline is Course OS `2.4.x`, a controlled personal preview. It is not a public multi-user service.

## Reporting

Do not put secrets, course material, learner data, production hostnames, private paths, or exploit details in a public issue. Use the repository owner's private GitHub security-reporting channel.

## Security defaults

- Local API and preview services bind to loopback addresses by default.
- PostgreSQL and ReadWeave are not exposed directly to the public network.
- Uploads validate extension, MIME type, magic bytes, size, and suspicious payload markers before conversion.
- Conversion runs with a read-only filesystem, no network, dropped capabilities, resource limits, and a temporary filesystem.
- Source bytes use SHA-256 content addressing and deduplication.
- Browser writes are workspace-scoped, release-pinned, request-identified, and idempotent.
- Secrets are mounted from private files and are never returned to the browser.
- Public Git excludes `var`, databases, logs, private course assets, runtime evidence, host configuration, and environment files.

## Release gate

Every public release must pass tests, type checking, build, course/tree/route/writing verification, Compose validation, public-content scanning, clean-history secret scanning, and license checks. A denied or incomplete publication gate blocks publishing and deployment.

Do not describe a deployment as healthy until authenticated access, spoofed-header rejection, restart persistence, ReadWeave idempotency, backup, and rollback checks have passed for that exact commit.
