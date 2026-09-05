# Base stage for node_modules installation and building
FROM node:20-alpine AS builder

# Install system dependencies
# openssl: required by Prisma | git: required to resolve git info for /api/version
RUN apk add --no-cache openssl git

# Build-time git metadata (injected by CI via --build-arg or docker-compose args)
# Falls back to 'unknown' if not provided
ARG GIT_COMMIT=unknown
ARG GIT_BRANCH=unknown
ARG GIT_TAG=unknown
ARG BUILD_TIME=unknown

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

# Bake git metadata into environment variables so they are readable at runtime
# even though .git folder may not be present in the container.
ENV GIT_COMMIT=${GIT_COMMIT} \
    GIT_BRANCH=${GIT_BRANCH} \
    GIT_TAG=${GIT_TAG} \
    BUILD_TIME=${BUILD_TIME}

# Default command to run dev mode if not overridden
CMD ["npm", "run", "dev"]
