FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data CHROMIUM_PATH=/usr/bin/chromium CHROMIUM_NO_SANDBOX=true CHROMIUM_SINGLE_REPLICA=true CHROMIUM_CPU_LIMIT=2
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation tini util-linux && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
