# API Endpoints Explanation

This document provides a short explanation for every API endpoint in the system.

## Auth Service
**Admin Flow:**
- `POST /api/auth/admin/registration`: Registers a new admin account and sends an OTP.
- `POST /api/auth/admin/verify-registration`: Verifies the registration OTP to activate the admin account.
- `POST /api/auth/admin/login`: Initiates admin login and sends a 2FA OTP.
- `POST /api/auth/admin/verify-login`: Verifies the login OTP and returns JWT tokens.
- `POST /api/auth/admin/forgot-password`: Triggers a password reset email/OTP for admins.
- `POST /api/auth/admin/verify-forgot-password-admin`: Verifies the OTP for admin password reset.
- `POST /api/auth/admin/reset-password`: Sets a new password for the admin account.

**User Flow:**
- `POST /api/auth/user/registration`: Registers a new standard user and sends an OTP.
- `POST /api/auth/user/verify-registration`: Verifies the user's registration OTP.
- `POST /api/auth/user/login`: Initiates user login.
- `POST /api/auth/user/verify-login`: Verifies the user login OTP and issues JWTs.
- `POST /api/auth/user/forgot-password`: Triggers password reset for standard users.
- `POST /api/auth/user/verify-forgot-password-user`: Verifies the reset OTP.
- `POST /api/auth/user/reset-password`: Sets a new password for the user.

## Admin Feature Service
- `GET /api/hello`: A simple healthcheck endpoint for the Next.js API.
- `POST /api/admin/stocks`: Used by the admin dashboard to configure/add a new stock to the platform.
- `DELETE /api/admin/stocks`: Removes a stock from the active platform list.
- `POST /api/admin/stocks/clear-history`: Truncates or deletes historical database records for a specific stock.

## Chat & Gateway Service (Core Hub)
- `GET /api/market-data/history`: Fetches historical `stock_ticks` (Angel One live feed history) for a given symbol from TimescaleDB.
- `GET /api/market-data/stocks`: Fetches the list of all currently active and listed stocks from Redis (for both admin and users).
- `POST /api/market-data/stocks`: The main endpoint triggered when a stock is added. Instantly returns success, subscribes to the Angel One WebSocket, and spins up background throttled fetchers for both Angel One and Fyers historical data.
- `DELETE /api/market-data/stocks`: Unsubscribes a stock from the live feeds and cleans up background tasks.
- `GET /api/`: Basic healthcheck for the NestJS chat-service.
- **WebSocket (`/socket.io/`)**: The main real-time connection point for all clients. Emits both chat messages and unified real-time stock/chart data via Kafka consumption.

## Fyers Chart Service
- `GET /api/fyers/callback`: The OAuth 2.0 callback endpoint. Fyers redirects here after manual login. It exchanges the `auth_code` for `access_token` and `refresh_token` and saves them to Redis.
- `GET /api/fyers/history`: Public REST endpoint to fetch `fyers_candles` data directly from TimescaleDB for rendering initial charts.
- `POST /api/fyers/internal/subscribe`: Used internally by `chat-service` to command the Fyers service to fetch a specific candle (e.g. 1m, 15m) when a user opens a chart.
- `POST /api/fyers/internal/fetch-all-history`: Used internally by `chat-service` when an Admin adds a stock. It spins up the massive, rate-limit-safe background task to download 1 year of 1m, 15m, and 4h data.
