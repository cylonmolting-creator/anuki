FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy application
COPY . .

# Create data directories and set ownership
RUN mkdir -p data logs memory && \
    addgroup -S anuki && adduser -S anuki -G anuki && \
    chown -R anuki:anuki /app

USER anuki

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
