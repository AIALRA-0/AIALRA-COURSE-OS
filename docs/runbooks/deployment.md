# VPS deployment runbook

Course OS 2.4 is deployed from an exact public `main` commit. Production hostnames, filesystem paths, authentication callbacks, network names, and secret values stay only in the private VPS environment.

## Required private variables

Start from `deploy/vps/.env.example` and keep the real file outside Git. At minimum, set immutable `COURSE_OS_RUNTIME_IMAGE` and `COURSE_OS_CONVERTER_IMAGE` tags, `COURSE_OS_PUBLIC_HOST`, `READWEAVE_BASE_URL`, `COURSE_OS_PRIVATE_NETWORK`, and `MODEL_ROUTER_NETWORK`.

Secret files are mounted from `COURSE_OS_SECRET_DIR`. Each secret must be readable only by its operator account; the ReadWeave token file must remain mode `0600`.

## Preflight

1. Record the exact Git commit, `df`, all containers, images, volumes, and Compose configuration.
2. Estimate the build's peak disk use and retain enough space for the current and rollback images; stop if this specific build would exhaust the disk.
3. Verify the previous Compose file, runtime image, converter image, PostgreSQL backup, and ReadWeave snapshot are recoverable.
4. Run the full local quality suite and a focused scan for secrets, private course files, server identifiers, and deployment evidence before publication.

Validate the template without starting services:

```sh
docker compose --env-file /private/course-os.env -f deploy/vps/compose.yaml config --quiet
```

## ReadWeave reconciliation

Rotate an invalid token atomically, restart only the Course OS API, and verify `/healthz` before any data operation. Run `pnpm promote:readweave` first; it is dry-run by default. Review every hash and only then run `pnpm promote:readweave -- --apply`.

The promotion command creates missing releases and drafts only. It stops on a same-ID/different-hash object and never deletes data or overwrites an existing draft. Never copy `readweave-course-store.json` over the remote authority.

## Build and switch

### Confirmed reading copies

The normal catalog and lesson routes read a persistent, private directory under
`COURSE_OS_DATA_DIR/confirmed-reading`. ReadWeave remains the content authority;
these copies are never written back to it. Retain this directory across API
restarts and include it in the existing data-volume backup.

Before first activation, use the same private environment, mounted credentials,
settings vault, and data volume as the API to confirm existing authority data:

```sh
node --import tsx scripts/materialize-reading.ts
```

This is an operator action, not a startup job. It atomically activates confirmed
catalog/page copies and does not generate teaching content. Later acknowledged
content writes update their copies; bounded background refresh reconciles
metadata and native edits. A failed refresh retains confirmed readable content,
but an explicit authority denial stops reading. Credential or authority changes
select a new namespace and require confirmation before that namespace is ready.

`/healthz` checks process liveness. `/readyz` separately checks whether a trusted
reading catalog is available; `/api/v1/reading/status` reports its last confirmation
and synchronization condition. No-data installations are not reading-ready even
when settings and liveness work. A source outage can leave reading ready with
degraded synchronization; it never means an unacknowledged answer was saved.

Before switching production, verify readiness, an actual catalog, and an existing
single-page lesson. Keep public authenticated browser acceptance separate from
loopback or transparent-tunnel checks. Do not cancel sessions or answer writes
to make a learning-flow check pass. Keep the existing PostgreSQL single-writer
lock and retain the previous image/Compose configuration for rollback.

The runtime image carries the package-manager cache from the build stage and
disables runtime Corepack downloads. Check `pnpm --version` with container
networking disabled before activation, so API startup cannot wait on the package
registry even though application network access remains available.

Build both images from the exact public commit and tag them `2.4.0-<short-sha>`. Put those tags in the private environment file, then apply Compose. API, web, worker, and converter must switch together.

Keep the prior Compose file and images until internal health, external HTTPS, authentication, static assets, restart persistence, and a second no-op ReadWeave dry-run all pass.

## Rollback

Restore the previous private environment and Compose file, then reapply the retained immutable images. Do not modify historical ReadWeave releases during application rollback. If health still fails, stop and restore from the verified database and ReadWeave backups rather than deleting or overwriting authority data.
