# AiTradesignal Monorepo

Welcome to the **AiTradesignal** monorepo! This project is built using [Nx](https://nx.dev) as a Smart Monorepo and uses a microservice-based architecture to power stock trading signal ingestion, real-time analytics, and user authentication.

---

## 🏗️ Architecture Overview

The system consists of the following primary components:
1. **Frontend / Admin UI (`admin-feature`)**: A Next.js dashboard application allowing administrators to register and manage stock lists and monitor streaming ticks.
2. **Authentication Service (`auth-service`)**: A Next.js REST API microservice managing User and Admin registrations, registration approvals, and secure 2FA/OTP login flows.
3. **Gateway & Chat Service (`chat-service`)**: A NestJS microservice coordinating historical tick fetching from TimescaleDB, Redis caching, Kafka message broker, and serving Socket.io connections for real-time stock stream pushes.
4. **Data Infrastructure**:
   - **TimescaleDB (PostgreSQL)**: Stores historical stock tick log records.
   - **Apache Kafka / Zookeeper**: Manages real-time data streaming queues.
   - **Upstash Redis**: Tracks active websocket subscriber counts and maps connections.
   - **MongoDB (Atlas)**: Keeps persistent user and administrator credentials.

---

## 📂 Project Structure

```
ai-tradesignal/
├── apps/
│   ├── admin-feature/      # Next.js admin dashboard frontend
│   ├── auth-service/       # Next.js auth REST API service
│   └── chat-service/       # NestJS backend gateway & websockets
├── libs/
│   └── error-handling/     # Shared error handling middlewares
├── prisma/
│   └── schema.prisma       # Prisma DB models for MongoDB (User & Admin)
├── deployment/             # Containerized production/staging deployment
│   ├── cloudflared/        # Cloudflare tunnel ingress & credentials
│   ├── nginx/              # Nginx SSL-terminating reverse proxy configuration
│   └── docker-compose.yml  # Unified Docker compose execution script
└── Dockerfile              # Monorepo multi-stage Docker builder configuration
```

---

## 💻 Development Guide

To run apps in development mode on your host machine:

### 1. Install Dependencies
```sh
npm install
```

### 2. Generate Prisma Client
```sh
npx prisma generate
```

### 3. Run Services Individually
```sh
# Start the Auth Service (Next.js)
npx nx dev auth-service

# Start the Gateway & Chat Service (NestJS)
npx nx dev chat-service

# Start the Admin Dashboard (Next.js)
npx nx dev admin-feature
```

---

## 🚀 Docker Deployment Guide

The `deployment` folder contains all the files needed to compile and orchestrate the complete stack inside Docker, securing internal and external endpoints using HTTPS.

### 🛡️ Secure Ingress Flow
```
Client --[HTTPS]--> Cloudflare Edge --[Outbound Tunnel]--> Cloudflared Container --[HTTPS]--> Nginx Container --[HTTP]--> Microservices (Docker network)
```

### Setup & Run Instructions

#### 1. Configure Cloudflared Credentials
Open [`deployment/cloudflared/817d64a4-b9ed-425e-90ca-4f27901397e3.json`](file:///c:/Users/daksh/OneDrive/Desktop/trading_guy/ai-tradesignal/deployment/cloudflared/817d64a4-b9ed-425e-90ca-4f27901397e3.json) and replace placeholder variables with your active Cloudflare tunnel credentials:
```json
{
  "AccountTag": "your-cloudflare-account-tag",
  "TunnelSecret": "your-tunnel-secret",
  "TunnelID": "817d64a4-b9ed-425e-90ca-4f27901397e3"
}
```

#### 2. Run the Stack
Navigate to the deployment directory and launch:
```powershell
cd deployment
docker compose up --build -d
```
On the initial launch:
* A helper `cert-generator` container starts automatically, generates self-signed SSL certificates for `digitaldigimart.shop` inside `./nginx/certs/`, and exits.
* Nginx boots up terminating SSL on port `443` using the generated certificates.
* NextJS and NestJS apps compile and start.
* TimescaleDB, PgAdmin, Kafka, and Zookeeper spin up.
* Cloudflared connects to Cloudflare Edge, routing inbound traffic from `digitaldigimart.shop` securely.

#### 3. View Containers & Logs
To verify that everything is running:
```powershell
docker compose ps
docker compose logs -f
```
To stop the stack:
```powershell
docker compose down
```
