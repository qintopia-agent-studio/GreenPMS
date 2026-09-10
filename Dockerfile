ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json CHANGELOG.md ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/web/vite.config.ts apps/web/vite.config.ts
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
COPY scripts/check-release.mjs scripts/check-release.mjs
COPY scripts/build-runtime.mjs scripts/build-runtime.mjs
COPY docs/releases docs/releases
COPY deploy/release-policy.json deploy/release-policy.json
COPY tests/helpers/create-restore-fixture.ts tests/helpers/create-restore-fixture.ts
COPY tests/helpers/auth-principals.ts tests/helpers/auth-principals.ts

RUN npm ci --ignore-scripts

COPY apps/api/src apps/api/src
COPY apps/web/index.html apps/web/index.html
COPY apps/web/public apps/web/public
COPY apps/web/src apps/web/src
COPY packages/contracts/src packages/contracts/src
COPY packages/domain/src packages/domain/src
COPY packages/db/src packages/db/src
COPY packages/db/catalog packages/db/catalog

RUN npm run build
RUN node scripts/build-runtime.mjs --source-root /app --output /app/runtime
CMD ["npm", "start"]

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

ARG OCI_VERSION
ARG OCI_REVISION
ARG OCI_SOURCE=https://github.com/qintopia-agent-studio/GreenPMS
ARG OCI_CREATED
LABEL org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}" \
      org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.created="${OCI_CREATED}"

COPY --from=build /app/runtime/ ./
RUN npm ci --omit=dev --ignore-scripts \
  && rm -f package.json package-lock.json

EXPOSE 4100
CMD ["node", "apps/api/src/main.js"]
