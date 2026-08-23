# API Endpoints Documentation

Below is the exhaustive list of all API endpoints exposed by the backend services.

## Auth Service (`/api/auth`)
### Admin Authentication
- `POST /api/auth/admin/registration`
- `POST /api/auth/admin/verify-registration`
- `POST /api/auth/admin/login`
- `POST /api/auth/admin/verify-login`
- `POST /api/auth/admin/forgot-password`
- `POST /api/auth/admin/verify-forgot-password-admin`
- `POST /api/auth/admin/reset-password`

### User Authentication
- `POST /api/auth/user/registration`
- `POST /api/auth/user/verify-registration`
- `POST /api/auth/user/login`
- `POST /api/auth/user/verify-login`
- `POST /api/auth/user/forgot-password`
- `POST /api/auth/user/verify-forgot-password-user`
- `POST /api/auth/user/reset-password`

## Admin Feature Service (`/api/admin`)
- `GET /api/hello`
- `POST /api/admin/stocks`
- `DELETE /api/admin/stocks`
- `POST /api/admin/stocks/clear-history`

## Chat & Gateway Service (`/api/`)
- `GET /api/market-data/history`
- `POST /api/market-data/stocks`
- `DELETE /api/market-data/stocks`
- `GET /api/` (Healthcheck)
- **WebSocket**: `/socket.io/`

## Fyers Chart Service (`/api/fyers`)
- `GET /api/fyers/callback`
- `GET /api/fyers/history`
- `POST /api/fyers/internal/subscribe` (Internal Only)
- `POST /api/fyers/internal/fetch-all-history` (Internal Only)
- **WebSocket**: `/socket.io-fyers/` (Deprecated/Replaced by Chat Service)
