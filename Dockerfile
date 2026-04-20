FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy application
COPY . .

# Create data directories
RUN mkdir -p data logs memory

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
