# syntax=docker/dockerfile:1

# One image, four processes: the API (default CMD) and the indexer/notifier/keeper
# workers, selected by overriding CMD at `docker run` — see README.md "Running in
# Docker". They share the same dist/ and dependencies, so one image is the whole story.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Runs as the image's own non-root "node" user rather than root.
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
