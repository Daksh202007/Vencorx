# API Documentation

This document describes all the API and WebSocket endpoints for **Authentication**, **Real-Time Chat & Stock Streaming**, and **Admin Stock Management** microservices.

---

## 1. Authentication Service (`auth-service`)

**Base Path:** `http://localhost:3000/api/auth`

### User Endpoints

#### 1. Register User

Initiates a new user registration. If registration is successful, sends a 4-digit OTP to the user's email.

- **Method:** `POST`
- **Path:** `/user/registration`
- **Request Body:**
  ```json
  {
    "name": "John Doe",
    "email": "johndoe@example.com",
    "password": "strongPassword123"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "OTP sent to johndoe@example.com"
  }
  ```

#### 2. Verify User Registration

Verifies the user registration using the 4-digit OTP code sent to their email.

- **Method:** `POST`
- **Path:** `/user/verify-user`
- **Request Body:**
  ```json
  {
    "email": "johndoe@example.com",
    "otp": "1234"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Verification successful",
    "accessToken": "eyJhbG...",
    "refreshToken": "eyJhbG..."
  }
  ```

#### 3. User Login

Logs in a verified user using their email and password.

- **Method:** `POST`
- **Path:** `/user/login`
- **Request Body:**
  ```json
  {
    "email": "johndoe@example.com",
    "password": "strongPassword123"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Login successful",
    "accessToken": "eyJhbG...",
    "refreshToken": "eyJhbG..."
  }
  ```

#### 4. User Forgot Password

Initiates a password reset flow by sending a 4-digit OTP code to the user's registered email.

- **Method:** `POST`
- **Path:** `/user/forgot-password`
- **Request Body:**
  ```json
  {
    "email": "johndoe@example.com"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Password reset OTP sent to johndoe@example.com"
  }
  ```

#### 5. Verify User Forgot Password OTP

Verifies the forgot password OTP and returns a short-lived `resetToken` (valid for 15 minutes) to authorize the password reset.

- **Method:** `POST`
- **Path:** `/user/verify-forgot-password-user`
- **Request Body:**
  ```json
  {
    "email": "johndoe@example.com",
    "otp": "1234"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "OTP verified successfully",
    "resetToken": "eyJhbG..."
  }
  ```

#### 6. Reset User Password

Resets the password of a user using a valid `resetToken`.

- **Method:** `POST`
- **Path:** `/user/reset-password`
- **Request Body:**
  ```json
  {
    "resetToken": "eyJhbG...",
    "newPassword": "newStrongPassword123"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Password reset successfully"
  }
  ```

#### 7. Refresh User Access Token

Generates a new pair of Access and Refresh tokens using a valid refresh token.

- **Method:** `POST`
- **Path:** `/user/new-access-token`
- **Request Body:**
  ```json
  {
    "refreshToken": "eyJhbG..."
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "accessToken": "eyJhbG...",
    "refreshToken": "eyJhbG..."
  }
  ```

---

### Admin Endpoints

#### 1. Register Admin

Registers a new admin account. Accounts are created in an unapproved state and require manual approval before they can log in.

- **Method:** `POST`
- **Path:** `/admin/registration`
- **Request Body:**
  ```json
  {
    "name": "Admin Name",
    "email": "admin@example.com",
    "password": "veryStrongAdminPassword123!"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Admin registered successfully. Waiting for approval."
  }
  ```

#### 2. Approve Admin Registration

Approves and verifies an admin registration.

- **Method:** `POST`
- **Path:** `/admin/verify-registration`
- **Headers:** `Authorization: Bearer <Admin_Access_Token>`
- **Request Body:**
  ```json
  {
    "adminEmailToApprove": "admin@example.com"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Admin admin@example.com has been approved."
  }
  ```

#### 3. Admin Login

Initiates the 2-step login process for an approved admin by verifying their credentials and generating a 4-digit OTP sent to their email.

- **Method:** `POST`
- **Path:** `/admin/login`
- **Request Body:**
  ```json
  {
    "email": "admin@example.com",
    "password": "veryStrongAdminPassword123!"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "OTP sent for login verification"
  }
  ```

#### 4. Verify Admin Login OTP

Verifies the 2FA login OTP for the admin and returns the tokens.

- **Method:** `POST`
- **Path:** `/admin/verify-login`
- **Request Body:**
  ```json
  {
    "email": "admin@example.com",
    "otp": "1234"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Admin login successful",
    "accessToken": "eyJhbG...",
    "refreshToken": "eyJhbG..."
  }
  ```

---

## 2. Chat & Stock Streaming Service (`chat-service`)

**Base Path:** `http://localhost:3001/api`

### HTTP REST Endpoints

#### 1. Fetch Stock History

Fetches historical time-series stock ticks/candles from PostgreSQL/TimescaleDB database.

- **Method:** `GET`
- **Path:** `/market-data/history`
- **Query Parameters:** `stock=<symbol>` (e.g. `RELIANCE`)
- **Success Response (200 OK):**
  ```json
  {
    "stock": "RELIANCE",
    "history": [
      {
        "stock": "RELIANCE",
        "lastTradedPrice": 2405.2,
        "open": 2395.0,
        "high": 2420.5,
        "low": 2390.0,
        "close": 2400.1,
        "lastTradeQuantity": 10,
        "exchangeFeedTime": "2026-08-21T10:00:00.000Z",
        "exchangeTradeTime": "2026-08-21T10:00:00.000Z",
        "netChange": 10.2,
        "percentChange": 0.43,
        "averagePrice": 2400.1,
        "tradeVolume": 52000,
        "openInterest": 120000,
        "lowerCircuit": 2155.5,
        "upperCircuit": 2634.5,
        "totalBuyingQuantity": 150000,
        "totalSellingQuantity": 134000,
        "fiftyTwoWeekLow": 1680.0,
        "fiftyTwoWeekHigh": 2800.0,
        "depth": {
          "buy": [{ "price": 2405.1, "quantity": 100, "orders": 2 }],
          "sell": [{ "price": 2405.3, "quantity": 50, "orders": 1 }]
        },
        "timestamp": "2026-08-21T10:00:00.000Z"
      }
    ]
  }
  ```

#### 2. Register Stock Streaming

Fetches 2000 days of historical candles from Angel One REST API (maximum 3 requests per second limit) and adds it to the active live connection pool.

- **Method:** `POST`
- **Path:** `/market-data/stocks`
- **Request Body:**
  ```json
  {
    "symbol": "RELIANCE",
    "exchange": "NSE"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Successfully loaded 2000 days of daily history (2000 rows) and subscribed stock \"RELIANCE\" to WebSocket pool."
  }
  ```

#### 3. Unsubscribe Stock Streaming

Removes the stock from active WebSocket streaming pool (freeing up capacity in the connection pool), preserving all historical database logs.

- **Method:** `DELETE`
- **Path:** `/market-data/stocks`
- **Request Body:**
  ```json
  {
    "symbol": "RELIANCE"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Successfully unsubscribed stock \"RELIANCE\" from active WebSocket connections. All historical tick data has been preserved."
  }
  ```

---

### WebSocket Gateways

**Connection Endpoint:** `ws://localhost:3001`

- **Authentication:** Must provide a valid JWT bearer token in query parameter or connection auth headers (e.g. `token = <accessToken>`).

#### Incoming Client Events:

##### 1. `join_chat`

Joins a specific chat channel or stock discussion group.

- **Payload:**
  ```json
  { "room": "general" }
  ```
- **Emits back (`chat_history`):**
  ```json
  {
    "room": "general",
    "history": [
      {
        "room": "general",
        "senderId": "user123",
        "senderName": "johndoe@example.com",
        "message": "Hello everyone!",
        "timestamp": "2026-08-21T10:05:00.000Z"
      }
    ]
  }
  ```

##### 2. `send_message`

Sends a chat message to a room.

- **Payload:**
  ```json
  {
    "room": "general",
    "message": "Nice rally on Reliance today!"
  }
  ```
- **Server broadcasts (`new_message`) to room:**
  ```json
  {
    "room": "general",
    "senderId": "user123",
    "senderName": "johndoe@example.com",
    "message": "Nice rally on Reliance today!",
    "timestamp": "2026-08-21T10:06:00.000Z"
  }
  ```

##### 3. `subscribe_stocks`

Subscribes to live price tick streams for a list of stocks. Updates Redis sets to track connection mappings.

- **Payload:**
  ```json
  { "stocks": ["RELIANCE", "TCS"] }
  ```
- **Emits back stock history (`stock_history`):**
  ```json
  {
    "stock": "RELIANCE",
    "ticks": [ ... historical tick logs ... ]
  }
  ```
- **Server broadcasts live updates (`stock_tick`) as they happen:**
  ```json
  {
    "stock": "RELIANCE",
    "lastTradedPrice": 2406.8,
    "volume": 200,s
    "timestamp": "2026-08-21T10:07:05.100Z",
    ... other FULL mode Angel One tick fields ...
  }
  ```

---

## 3. Admin Feature Service (`admin-feature`)

**Base Path:** `http://localhost:3002/api/admin`

#### 1. Add Stock

Registers a new stock, triggers 2000 days history fetch, and subscribes it to the active live connection pool in `chat-service`.

- **Method:** `POST`
- **Path:** `/stocks`
- **Request Body:**
  ```json
  {
    "symbol": "TCS",
    "exchange": "NSE"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Successfully loaded 2000 days of daily history (2000 rows) and subscribed stock \"TCS\" to WebSocket pool."
  }
  ```

#### 2. Delete Stock from Streaming

Unsubscribes a stock from the active WebSocket connection pool, leaving historical database logs intact.

- **Method:** `DELETE`
- **Path:** `/stocks`
- **Request Body:**
  ```json
  {
    "symbol": "TCS"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Successfully unsubscribed stock \"TCS\" from active WebSocket connections. All historical tick data has been preserved."
  }
  ```

#### 3. Clear Stock History

Administrative destructive action that purges all historical database records (candles & ticks) for a stock.

- **Method:** `POST`
- **Path:** `/stocks/clear-history`
- **Request Body:**
  ```json
  {
    "symbol": "TCS"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Successfully purged all historical tick logs for stock \"TCS\" from TimescaleDB. Rows affected: 4500"
  }
  ```
