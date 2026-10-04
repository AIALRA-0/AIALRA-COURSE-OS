# VPS deployment runbook

Course OS 2.4 is deployed from an exact public `main` commit. Production hostnames, filesystem paths, authentication callbacks, network names, and secret values stay in the runtime environment.

## Required private variables

Start from `deploy/vps/.env.example` and keep the real file outside Git. At minimum, set immutable `COURSE_OS_RUNTIME_IMAGE` and `COURSE_OS_CONVERTER_IMAGE` tags, `COURSE_OS_PUBLIC_HOST`, `READWEAVE_BASE_URL`, `COURSE_OS_PRIVATE_NETWORK`, and `MODEL_ROUTER_NETWORK`.

Secret files are mounted from `COURSE_OS_SECRET_DIR`. Each secret must be readable only by its operator account; the ReadWeave token file must remain mode `0600`.

## Preflight

1. Record the exact Git commit, available disk, containers, images, volumes, and active Compose configuration.
2. Estimate peak disk use for this build, the current images, and the images retained for rollback. Stop if available space cannot complete the operation.
3. Verify that the previous Compose configuration and immutable images, PostgreSQL backup, ReadWeave authority backup, and Course OS data-volume backup are recoverable. Preserve the configured backup-retention schedule during deployment and rollback.
4. From a clean checkout, use the lockfile install and synthetic startup documented in the repository README as the source-tree smoke check. Complete the required release checks for the candidate before building deployment images.

Validate the template without starting services, using the operator's environment-file variable:

```sh
docker compose --env-file "$COURSE_OS_ENV_FILE" -f deploy/vps/compose.yaml config --quiet
```

## ReadWeave reconciliation

Rotate an invalid token atomically and restart only the Course OS API. Check `/healthz` for process liveness and `/readyz` for confirmed reading data before serving lessons. An empty installation can return healthy from `/healthz` while `/readyz` remains unavailable until an operator confirms existing authority data. Run `pnpm promote:readweave` first; it is dry-run by default. Review every hash and only then run `pnpm promote:readweave -- --apply`.

The promotion command creates missing releases and drafts only. It stops on a same-ID/different-hash object and never deletes data or overwrites an existing draft. Never copy `readweave-course-store.json` over the remote authority.

## Build and switch

### Confirmed reading copies

The normal catalog and lesson routes read a persistent confirmed replica under
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

`/healthz` checks process liveness. `/readyz` checks whether confirmed reading
data is available; `/api/v1/reading/status` reports its last confirmation and
synchronization condition. No-data installations are not reading-ready even
when settings and liveness work. A transient source outage can leave the service
reading-ready with degraded synchronization: previously confirmed content stays
available read-only, while writes still require acknowledgment from ReadWeave.
An explicit 401/403 authorization denial invalidates reading readiness and stops
reading until access is restored and confirmation succeeds.

Before switching production, verify readiness, an actual catalog, and an existing
single-page lesson. Keep public authenticated browser acceptance separate from
loopback or transparent-tunnel checks. Do not cancel sessions or answer writes
to make a learning-flow check pass. Keep the existing PostgreSQL single-writer
lock and retain the previous image/Compose configuration for rollback.

The runtime image carries the package-manager cache from the build stage and
disables runtime Corepack downloads. Check `pnpm --version` with container
networking disabled before activation, so API startup cannot wait on the package
registry even though application network access remains available.

Build only affected components from the exact candidate commit and tag them `2.4.0-<short-sha>`. Put those tags in the private deployment configuration, then apply Compose. API and worker must use compatible adapter code; retain an unchanged converter image. Record each component's actual commit and digest rather than assuming one version for all services.

### Confirmed writes and deletion capability

For an existing ETAPI installation, activate the small metadata index once with
the candidate image's existing operator script:

```sh
node --import tsx scripts/materialize-reading.ts --metadata-index
```

Stop the API and worker first. Use the API's actual environment, mounted secrets,
settings vault and PostgreSQL connection. The command holds the existing API
writer lease, resumes interrupted activation and verifies the authority index.
It does not generate lessons. Rename/move/archive subsequently update that index
instead of copying teaching bodies. Keep the pre-switch Compose file and images.

A lost metadata-write response is an unknown result, not a failed transaction.
The browser preserves the original idempotency key for an explicit retry,
including after refresh or reopening a tab when browser storage is available. Do not replace that key or show a saved
state until the authority confirms the result.

An acknowledged write updates the reading copy from that specific result.
Ordinary name/location projection failures retain unrelated confirmed reading.
Deletion, archive and version-sensitive changes protect the affected object until
the matching authority revision is confirmed. Stale refreshes cannot clear that
protection. Keep the replica catalog with its persisted protections across
restarts; do not repair this condition by deleting the replica directory.

Check `/api/v1/trash/capabilities` before offering permanent deletion. The ETAPI
adapter reports that native ReadWeave UI authentication is required: its ordinary
note deletion is recoverable, and its API token does not authorize native erase.
Use the native UI's scoped confirmation under a legitimate logged-in session.
Never substitute an index-only removal, global erase, copied browser credentials,
or direct database deletion. Verify authority absence and shared references before
reporting that a selected object has been permanently removed.

Keep the prior Compose file and images until internal health, reading readiness, external HTTPS, authentication, static assets, restart persistence, and a second no-op ReadWeave dry-run all pass. Keep all database, authority, and data-volume backups under the existing 7-daily, 4-weekly, and 6-monthly retention schedule; deployment and rollback do not shorten or reset retention.

## Rollback

If the candidate activated the metadata index, stop the API and worker and run
the **candidate** image's script with the same private configuration and writer
lease before switching to an image that predates this split:

```sh
node --import tsx scripts/materialize-reading.ts --metadata-rollback
```

This confirms a legacy-readable root assembled from the current content and
current metadata; it does not restore an old snapshot over newer answers or
drafts. If confirmation fails, keep services stopped and preserve the evidence.
Then restore the previous runtime environment and Compose file and reapply the
retained immutable images. Preserve every backup and rollback point under the
existing retention schedule. Do not modify historical ReadWeave releases during
application rollback. If readiness or confirmed reading still fails, use the
verified PostgreSQL, ReadWeave and data-volume recovery procedure; never delete
or overwrite authority data merely to make startup pass.
