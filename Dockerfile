# Stage 1: Build
FROM node:22-slim AS build
WORKDIR /workspace

# Copy specification for proto generation
COPY specification /specification

# Build shared library
COPY implementation/client/client-node /workspace/client-node
WORKDIR /workspace/client-node
RUN npm install && npm run build

# Build puppeteer-agent
WORKDIR /workspace/puppeteer-agent
COPY implementation/client/puppeteer-replay-agent /workspace/puppeteer-agent
RUN npm install /workspace/client-node --no-save && npm install && npm run build

# Stage 2: Runtime
FROM node:22-slim
WORKDIR /app

# Install Chromium and its required dependencies
# Using the system-provided chromium ensures that all shared libraries are correctly mapped
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Environment variables to configure Puppeteer to use the system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copy built library and agent
COPY --from=build --chown=node:node /workspace/client-node /app/client-node
COPY --from=build --chown=node:node /workspace/puppeteer-agent /app/puppeteer-agent

USER node
WORKDIR /app/puppeteer-agent

# Default environment variables
ENV HUB_URL=http://cms:9000
ENV CLIENT_NAME=DockerPuppeteerAgent

# Run the compiled JavaScript directly with Node
CMD ["node", "dist/index.js"]
