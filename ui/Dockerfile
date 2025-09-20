FROM node:18-bullseye-slim

WORKDIR /app

# Install system dependencies including build tools
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies with legacy peer deps to avoid conflicts
RUN npm install --legacy-peer-deps

# Downgrade rollup to avoid native binary issues
RUN npm install rollup@3.29.4 --save-dev

# Copy source code
COPY . .

# Copy utils files to public directory for production build
RUN mkdir -p public/utils && cp -r src/utils/* public/utils/

# Build the application
RUN npm run build

EXPOSE 3000

# Serve the built application using a simple HTTP server
RUN npm install -g serve
CMD ["serve", "-s", "dist", "-l", "3000"]