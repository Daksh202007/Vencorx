# API Endpoints Documentation

Below is the exhaustive list of all API endpoints exposed by the backend services, complete with JSON payload and response examples.

---

### website name is ('https://vencorx.digitaldigimart.shop')

## Auth Service (`/api/auth`)

### Admin Authentication

#### `POST /api/auth/admin/registration`

**Request:**

```json
{
  "name": "Admin Name",
  "email": "admin@example.com",
  "password": "securepassword123"
}
```

**Response:**

```json
{
  "success": true,
  "message": "OTP sent to email"
}
```

#### `POST /api/auth/admin/verify-registration`

**Request:**

```json
{
  "email": "admin@example.com",
  "otp": "123456"
}
```

#### `POST /api/auth/admin/login`

**Request:**

```json
{
  "email": "admin@example.com",
  "password": "securepassword123"
}
```

#### `POST /api/auth/admin/verify-login`

**Request:**

```json
{
  "email": "admin@example.com",
  "otp": "123456"
}
```

**Response:**

```json
{
  "success": true,
  "accessToken": "eyJhbGciOiJSUzI1NiIs..."
}
```

#### `POST /api/auth/admin/forgot-password`

**Request:**

```json
{
  "email": "admin@example.com"
}
```

#### `POST /api/auth/admin/verify-forgot-password-admin`

**Request:**

```json
{
  "email": "admin@example.com",
  "otp": "123456"
}
```

#### `POST /api/auth/admin/reset-password`

**Request:**

```json
{
  "resetToken": "eyJhbGciOiJSUzI1...",
  "newPassword": "newsecurepassword123"
}
```

### User Authentication

_(User Auth endpoints mirror the Admin Auth payloads exactly)_

- `POST /api/auth/user/registration`
- `POST /api/auth/user/verify-registration`
- `POST /api/auth/user/login`
- `POST /api/auth/user/verify-login`
- `POST /api/auth/user/forgot-password`
- `POST /api/auth/user/verify-forgot-password-user`
- `POST /api/auth/user/reset-password`

---

## Feature Service (`/api/feature`)

_Requires `Authorization: Bearer <token>` header._

#### `GET /api/feature/user/me`

**Response:**

```json
{
  "success": true,
  "user": {
    "id": "60d5ecb8b392...",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "USER",
    "isVerified": true,
    "watchlist": ["RELIANCE-EQ"],
    "createdAt": "2023-10-01T12:00:00Z"
  }
}
```

#### `GET /api/feature/user/watchlist`

**Response:**

```json
{
  "success": true,
  "watchlist": ["RELIANCE-EQ", "TCS-EQ"]
}
```

#### `POST /api/feature/user/watchlist`

**Request:**

```json
{
  "symbol": "TCS-EQ"
}
```

**Response:**

```json
{
  "success": true,
  "watchlist": ["RELIANCE-EQ", "TCS-EQ"]
}
```

#### `DELETE /api/feature/user/watchlist`

**Request:**

```json
{
  "symbol": "TCS-EQ"
}
```

**Response:**

```json
{
  "success": true,
  "watchlist": ["RELIANCE-EQ"]
}
```

---

## Admin Feature Service (`/api/admin`)

_Requires Admin token._

#### `POST /api/admin/stocks`

**Request:**

```json
{
  "symbol": "RELIANCE-EQ",
  "exchange": "NSE"
}
```

#### `DELETE /api/admin/stocks`

**Request:**

```json
{
  "symbol": "RELIANCE-EQ"
}
```

#### `POST /api/admin/stocks/clear-history`

**Request:**

```json
{
  "symbol": "RELIANCE-EQ"
}
```

---

## Chat & Gateway Service (`/api/`)

#### `GET /api/market-data/history?stock=RELIANCE-EQ`

**Response:**

```json
{
  "stock": "RELIANCE-EQ",
  "history": [
    {
      "time": "2023-10-01T10:00:00Z",
      "open": 2500.5,
      "high": 2510.0,
      "low": 2490.5,
      "close": 2505.0,
      "volume": 15000
    }
  ]
}
```

#### `GET /api/market-data/stocks`

**Response:**

```json
{
  "success": true,
  "stocks": ["RELIANCE-EQ", "TCS-EQ", "INFY-EQ"]
}
```

#### `POST /api/market-data/stocks`

_(Internal equivalent to `/api/admin/stocks`)_
**Request:**

```json
{
  "symbol": "RELIANCE-EQ",
  "exchange": "NSE"
}
```

#### `DELETE /api/market-data/stocks`

**Request:**

```json
{
  "symbol": "RELIANCE-EQ"
}
```

---

## Fyers Chart Service (`/api/fyers`)

#### `GET /api/fyers/history?symbol=NSE:RELIANCE-EQ&resolution=15`

**Response:**

```json
{
  "s": "ok",
  "candles": [[1696123800, 2500.5, 2510.0, 2490.5, 2505.0, 15000]]
}
```

#### `POST /api/fyers/internal/subscribe` (Internal)

**Request:**

```json
{
  "symbol": "NSE:RELIANCE-EQ",
  "resolution": "15"
}
```

#### `POST /api/fyers/internal/fetch-all-history` (Internal)

**Request:**

```json
{
}
```

### Access Token Refresh (Admin & User)

#### `POST /api/auth/admin/new-access-token`
#### `POST /api/auth/user/new-access-token`

**Request (for both):**

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response (for both):**

```json
{
  "success": true,
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5c...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5c..."
}
```
