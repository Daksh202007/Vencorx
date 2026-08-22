# Base stage for node_modules installation and building
FROM node:20-alpine AS builder

# Install system dependencies (openssl is required by Prisma for database communication)
RUN apk add --no-cache openssl

WORKDIR /app

# Copy root configurations and dependency locks
COPY package*.json tsconfig.base.json nx.json ./

# Install development and production dependencies
RUN npm install

# Copy the Prisma schema and generate the Prisma Client
COPY prisma ./prisma
RUN npx prisma generate

# Copy the rest of the workspace source code
COPY . .

# Build all microservices in production mode
RUN npx nx run-many -t build --all

# Expose ports for NextJS and NestJS microservices
EXPOSE 3000 3001 3002

# Default command to run dev mode if not overridden
CMD ["npm", "run", "dev"]
