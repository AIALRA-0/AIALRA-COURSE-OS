#!/bin/sh
set -eu

psql \
  --set ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --file /docker-entrypoint-initdb.d/operational-schema.postgres
