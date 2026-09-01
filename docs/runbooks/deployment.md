# VPS deployment runbook

Course OS 2.4 is deployed from an exact public `main` commit. Production hostnames, filesystem paths, authentication callbacks, network names, and secret values stay only in the private VPS environment.

## Required private variables

Start from `deploy/vps/.env.example` and keep the real file outside Git. At minimum, set immutable `COURSE_OS_RUNTIME_IMAGE` and `COURSE_OS_CONVERTER_IMAGE` tags, `COURSE_OS_PUBLIC_HOST`, `READWEAVE_BASE_URL`, `COURSE_OS_PRIVATE_NETWORK`, and `MODEL_ROUTER_NETWORK`.

Secret files are mounted from `COURSE_OS_SECRET_DIR`. Each secret must be readable only by its operator account; the ReadWeave token file must remain mode `0600`.

## Preflight

1. Record the exact Git commit, `df`, all containers, images, volumes, and Compose configuration.
2. Require at least 40 GB free before any image build.
3. Verify the previous Compose file, runtime image, converter image, PostgreSQL backup, and ReadWeave snapshot are recoverable.
4. Run the full local gate and the clean-root publication gate. A denied or incomplete gate stops deployment.

Validate the template without starting services:

```sh
docker compose --env-file /private/course-os.env -f deploy/vps/compose.yaml config --quiet
```

## ReadWeave reconciliation

Rotate an invalid token atomically, restart only the Course OS API, and verify `/healthz` before any data operation. Run `pnpm promote:readweave` first; it is dry-run by default. Review every hash and only then run `pnpm promote:readweave -- --apply`.

The promotion command creates missing releases and drafts only. It stops on a same-ID/different-hash object and never deletes data or overwrites an existing draft. Never copy `readweave-course-store.json` over the remote authority.

## Build and switch

Build both images from the exact public commit and tag them `2.4.0-<short-sha>`. Put those tags in the private environment file, then apply Compose. API, web, worker, and converter must switch together.

Keep the prior Compose file and images until internal health, external HTTPS, authentication, static assets, restart persistence, and a second no-op ReadWeave dry-run all pass.

## Rollback

Restore the previous private environment and Compose file, then reapply the retained immutable images. Do not modify historical ReadWeave releases during application rollback. If health still fails, stop and restore from the verified database and ReadWeave backups rather than deleting or overwriting authority data.
