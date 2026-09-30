FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY infra ./infra
COPY config ./config
RUN pnpm install --frozen-lockfile
RUN pnpm -r build

FROM node:24-bookworm-slim AS runtime
RUN corepack enable
COPY --from=build /root/.cache/node/corepack /root/.cache/node/corepack
ENV COREPACK_ENABLE_NETWORK=0
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
CMD ["sh", "-c", "pnpm --filter @course-os/${COURSE_OS_APP} start"]

FROM runtime AS app-runtime
