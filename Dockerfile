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
WORKDIR /app
COPY --from=build /app /app
CMD ["sh", "-c", "pnpm --filter @course-os/${COURSE_OS_APP} start"]

FROM runtime AS app-runtime
