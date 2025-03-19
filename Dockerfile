# Use Node 18 as base image
FROM node:18-bullseye-slim

# Install dependencies for Playwright
RUN apt-get update && apt-get install -y \
  wget \
  chromium \
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/lib/playwright \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies and Playwright
RUN npm install && \
  npx playwright install chromium --with-deps

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3000

# Run migrations and start the server
CMD npm run db:push && npm run start