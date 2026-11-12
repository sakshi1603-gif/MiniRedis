
FROM node:22-bookworm-slim

# Set working directory inside container
WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy TypeScript configuration
COPY tsconfig.json ./

# Copy source code
COPY src ./src

# Create persistence directory
RUN mkdir -p /data

# Configure application
ENV PORT=6391
ENV SNAPSHOT_PATH=/data/dump.json

# Document the container port
EXPOSE 6391

# Start Mini Redis
CMD ["npm", "start"]
