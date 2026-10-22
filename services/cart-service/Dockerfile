# CloudCart cart-service
# Small, production-style image: install only runtime deps, run as non-root user.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first so Docker can cache this layer between code changes
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source
COPY . .

# Run as the unprivileged "node" user that the base image provides
USER node

EXPOSE 5003

# Container-level health check (ECS can also use this)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5003/health || exit 1

CMD ["node", "server.js"]
