FROM --platform=linux/amd64 python:3.11-slim

WORKDIR /app

# Install system dependencies for headless Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies + AWS CLI (for crash handler in entrypoint.sh)
RUN pip install --no-cache-dir -r requirements.txt awscli

# Setup Crawl4AI browser
RUN crawl4ai-setup

# Copy worker package + entrypoint wrapper
COPY worker/ ./worker/
COPY urls.yaml .
COPY entrypoint.sh .

# Create output directory
RUN mkdir -p /app/output

# Environment variables (overridden by ECS task / docker-compose / CLI)
ENV USE_S3="true"
ENV S3_BUCKET=""
ENV AWS_DEFAULT_REGION="us-east-1"
ENV SEED_URL=""
ENV JOB_ID=""
ENV SCOPE_TYPE="all"
ENV MAX_DEPTH="2"
ENV MAX_PAGES="500"
ENV MAX_CONCURRENT="20"
ENV USE_BROWSER="auto"
ENV CONFIG_PATH="urls.yaml"

# Run the crawler via entrypoint wrapper (writes FAILED status on crash/OOM)
CMD ["/bin/bash", "/app/entrypoint.sh"]
