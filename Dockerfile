FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src

# Listens inside the container network only; deploy/docker-compose.yml puts
# Caddy (automatic HTTPS) in front. Never publish 8787 directly.
ENV NODE_ENV=production \
    IMALI_TRANSPORT=http \
    IMALI_HOST=0.0.0.0 \
    IMALI_ALLOW_REMOTE=1 \
    IMALI_TRUST_PROXY=1 \
    IMALI_WORKSPACE=/workspace \
    IMALI_HOME=/data

RUN mkdir -p /workspace /data && chown node:node /workspace /data
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "src/server.js"]
