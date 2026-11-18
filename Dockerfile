FROM node:22-bookworm

# Install Python 3, FFmpeg, FFprobe, aria2c, git, and build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    ffmpeg \
    aria2 \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install standalone yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Install Python dependencies including Wzgram
COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir -r requirements.txt || true

# Install Node.js dependencies
COPY package*.json ./
RUN npm install

# Copy application source
COPY . .

# Create storage and logs directories
RUN mkdir -p storage/downloads storage/thumbnails storage/temp database logs

# Build frontend
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
