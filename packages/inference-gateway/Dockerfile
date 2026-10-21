# Build from the repository root. The manifest-list digest fixes both supported architectures.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/web/package.json packages/web/package.json
COPY packages/inference-gateway/package.json packages/inference-gateway/package.json
RUN npm ci --workspace @dispatch/inference-gateway --ignore-scripts
COPY packages/inference-gateway/tsconfig.json packages/inference-gateway/tsconfig.json
COPY packages/inference-gateway/src packages/inference-gateway/src
RUN npm run build --workspace @dispatch/inference-gateway \
    && npm prune --workspace @dispatch/inference-gateway --omit=dev --ignore-scripts \
    && mkdir -p packages/inference-gateway/node_modules

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:55de7e48a8414e7aff825207c0b3c0f7db3b10133efc50d748560c27c9053be1
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/dispatchlabs-ai/dispatch" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY LICENSE ./LICENSE
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/inference-gateway/package.json ./packages/inference-gateway/package.json
COPY --from=build /app/packages/inference-gateway/node_modules ./packages/inference-gateway/node_modules
COPY --from=build /app/packages/inference-gateway/dist ./packages/inference-gateway/dist
USER 1000:1000
EXPOSE 8787
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["packages/inference-gateway/dist/cli.js", "serve"]
