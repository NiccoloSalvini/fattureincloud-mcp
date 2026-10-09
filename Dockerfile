# Remote server for claude.ai and other MCP clients, in OAuth mode.
# See «Server remoto (claude.ai)» in the README for the variables.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# npm ci runs `prepare`, which builds dist/; then drop the dev dependencies
RUN npm ci && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js", "http", "--oauth"]
