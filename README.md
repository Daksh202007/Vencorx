# Vencorx Backend Architecture

(any api request you want send please send this request this domain name)
https://vencorx.digitaldigimart.shop

(notice when you want to see the api endpoint please check following files)

- doc.md
- docExplaination.md

(2 notice you want to add any stock name please check this link below
you search name exited name that same copy name copy past to api , stock will be added successfully)

- (https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json)

it will take time to load jsons

This repository contains the complete backend microservices architecture for the Vencorx platform. It is a highly scalable, multi-service backend built using NestJS, Next.js API Routes, PostgreSQL (TimescaleDB), Redis, and Apache Kafka.

## System Architecture

The platform uses an Nginx reverse proxy to route traffic to the appropriate microservices. The backend is split into multiple independent services:

### 1. Nginx Reverse Proxy (`deployment/nginx/default.conf`)

Acts as the main API Gateway. It routes all incoming traffic (`/api/auth`, `/api/admin`, `/api/fyers`, `/socket.io`) to their respective Docker containers.

### 2. Auth Service (`apps/auth-service`)

- **Technology**: Next.js App Router (API Routes)
- **Purpose**: Handles all authentication (Registration, Login, OTP Verification, Password Resets) for both Users and Admins.
- **Database**: Connects to the primary PostgreSQL database using Prisma ORM.

### 3. Admin Feature Service (`apps/admin-feature`)

- **Technology**: Next.js App Router (API Routes)
- **Purpose**: Exposes administrative endpoints for managing the platform (e.g., adding/removing active stocks, clearing historical data).
- **Communication**: Interacts with PostgreSQL via Prisma and sends commands to other microservices.

### 4. Chat & Gateway Service (`apps/chat-service`)

- **Technology**: NestJS, Socket.io
- **Purpose**: The central real-time hub.
- **Features**:
  - **WebSocket Gateway (`/socket.io/`)**: Manages thousands of simultaneous WebSocket connections from frontend clients.
  - **REST Endpoints**: Provides endpoints for fetching active listed stocks (`GET /api/market-data/stocks`) and triggering background jobs.
  - **Angel One Integration (`AngelOneFetchService`)**: Connects directly to Angel One's live ticker WebSocket and processes real-time stock ticks.
  - **Throttled Historical Fetcher**: Pulls 5 years of daily historical data from Angel One in the background via strict chunking to avoid rate limits.
  - **Kafka Consumer**: Listens to Kafka topics (e.g., `fyers-chart-update-*`) and broadcasts real-time chart candles to subscribed users.

### 5. Fyers Chart Service (`apps/fyers-chart-service`)

- **Technology**: NestJS
- **Purpose**: Dedicated microservice for handling all Fyers API integrations.
- **Features**:
  - **OAuth 2.0 Auth Flow (`FyersAuthService`)**: Automatically manages Access and Refresh tokens using a daily Cron Job.
  - **Historical Data Engine (`FyersDataService`)**: Pulls 1m, 15m, and 4h historical data in large chunks.
  - **Throttled Fetching**: Intelligently chunks data (e.g., 90-day intervals) and sleeps between requests to protect the server's 2 vCPU / 8GB RAM limitations.
  - **Kafka Producer**: Publishes processed OHLCV candle updates to Kafka topics so the `chat-service` can stream them to the frontend.

### 6. Core Infrastructure (Docker)

- **PostgreSQL / TimescaleDB**: The primary database. TimescaleDB hypertables (`stock_ticks`, `fyers_candles`, `angel_candles`) are used for blazing fast time-series queries.
- **Redis**: Used for high-speed caching, storing Fyers API tokens, and maintaining active WebSocket session maps.
- **Kafka / Zookeeper**: The event bus for real-time inter-service communication (e.g., sending chart updates from `fyers-chart-service` to `chat-service`).

## Data Flow (Adding a Stock)

1. **Admin** hits `POST /api/admin/stocks` (or `POST /api/market-data/stocks`).
2. The endpoint instantly returns `Success` to the frontend so it doesn't freeze.
3. In the background, `chat-service` starts downloading 5 years of Angel One data in chunks.
4. Concurrently, an HTTP call is made to `fyers-chart-service` to start downloading 1 year of intraday data (1m, 15m, 4h).
5. The downloaded data is safely written into TimescaleDB without overloading the server.
