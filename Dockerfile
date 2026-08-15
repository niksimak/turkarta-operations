FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
# --ignore-scripts: the build only runs tsc, which doesn't need esbuild's native
# binary (pulled in via tsx). Skipping dep build scripts avoids pnpm 11's
# ERR_PNPM_IGNORED_BUILDS hard-fail without copying workspace config into the image.
RUN pnpm install --frozen-lockfile --ignore-scripts || pnpm install --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts || pnpm install --prod --ignore-scripts
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
EXPOSE 8000
CMD ["node", "dist/index.js"]
