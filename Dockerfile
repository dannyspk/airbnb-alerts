# Use official Node.js image (Debian variant) and ensure Python is available for pyairbnb
# Use Debian Bookworm variant so `apt-get install python3` provides Python >= 3.10
FROM node:20-bookworm-slim

# Create app directory
WORKDIR /app

# Install OS deps (python + pip) required by Python scraper
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy package files first for dependency install
COPY package.json package-lock.json* ./

# Install Node deps
RUN npm ci --only=production || npm install --only=production

# Copy Python requirements and install
COPY requirements.txt ./
RUN if [ -f requirements.txt ]; then pip3 install --no-cache-dir -r requirements.txt; fi

# Copy app source
COPY . ./

# Ensure temporary directory exists
RUN mkdir -p /tmp

ENV NODE_ENV=production
ENV PYTHON_PATH=python3
ENV TEMP_DIR=/tmp

# Default command (Railway/Procfile can override per service)
CMD ["node", "src/index.js"]
