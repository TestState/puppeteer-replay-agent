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

# Install Chrome and its required dependencies
# We use Google Chrome Stable (directly from Google) instead of Debian's outdated chromium package
# to ensure compatibility with the Puppeteer version we depend on.
RUN apt-get update && apt-get install -y \
    xvfb \
    xauth \
    gnupg \
    ca-certificates \
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

# Install Google Chrome Stable from the official repository
RUN wget --no-verbose -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list && \
    apt-get update && apt-get install -y google-chrome-stable --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Environment variables to configure Puppeteer to use the system Google Chrome
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
ENV DBUS_SESSION_BUS_ADDRESS=/dev/null

# Copy built library and agent
COPY --from=build --chown=node:node /workspace/client-node /app/client-node
COPY --from=build --chown=node:node /workspace/puppeteer-agent /app/puppeteer-agent
RUN chmod +x /app/puppeteer-agent/entrypoint.sh

USER node
WORKDIR /app/puppeteer-agent

# Default environment variables
ENV HUB_URL=http://cms:9000
ENV CLIENT_NAME=DockerPuppeteerAgent

ENTRYPOINT ["/app/puppeteer-agent/entrypoint.sh"]
CMD ["node", "dist/index.js"]
