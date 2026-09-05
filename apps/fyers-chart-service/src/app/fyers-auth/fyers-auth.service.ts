import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../redis/redis.service';
import axios from 'axios';
import * as crypto from 'crypto';

/** 16 hours in milliseconds */
const MEMORY_CACHE_TTL_MS = 16 * 60 * 60 * 1000;

interface MemoryTokenEntry {
  token: string;
  expiresAt: number; // epoch ms
}

@Injectable()
export class FyersAuthService implements OnModuleInit {
  private readonly logger = new Logger(FyersAuthService.name);
  private appId: string;
  private secretId: string;

  /**
   * In-memory token cache (single entry, map used for consistent API).
   * Only populated AFTER a real Fyers API call confirms the token is valid.
   * This eliminates Redis round-trips on every hot request.
   */
  private readonly memoryCache = new Map<string, MemoryTokenEntry>();

  /**
   * Circuit-breaker flag: set to true when Fyers rejects the token (-15/-16).
   * While true, getAccessToken() returns null immediately — no Redis fetch.
   * Reset only when: a new token is stored via generateTokensFromAuthCode()
   * or at 8 AM cron (so it re-checks Redis in case someone manually set a token).
   */
  private tokenInvalid = false;

  constructor(private readonly redisService: RedisService) {
    this.appId = process.env.FYERS_APP_ID || '';
    this.secretId = process.env.FYERS_SECRET_ID || '';
  }

  async onModuleInit() {
    this.logger.log('Fyers Auth Service initialized.');
    const token = await this.redisService.get('fyers_access_token');
    if (!token) {
      this.logger.warn('No Fyers access token found in Redis. Awaiting manual login.');
    }
  }

  // ---------------------------------------------------------------------------
  // Memory Cache helpers
  // ---------------------------------------------------------------------------

  private getFromMemory(): string | null {
    const entry = this.memoryCache.get('fyers_access_token');
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.memoryCache.delete('fyers_access_token');
      this.logger.warn('In-memory Fyers token expired — evicted from cache.');
      return null;
    }
    return entry.token;
  }

  private setInMemory(token: string): void {
    this.memoryCache.set('fyers_access_token', {
      token,
      expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
    });
    this.logger.log('Fyers access token promoted to in-memory cache (16h TTL).');
  }

  /** Clear memory cache — call this whenever a new token is written to Redis. */
  clearMemoryCache(): void {
    this.memoryCache.delete('fyers_access_token');
    this.logger.log('In-memory Fyers token cache cleared.');
  }

  /**
   * Mark the current token as permanently invalid (circuit-breaker).
   * Called by WS gateway when Fyers returns -15 / -16.
   * Prevents repeated Redis fetches with a dead token.
   */
  markTokenInvalid(): void {
    this.tokenInvalid = true;
    this.memoryCache.delete('fyers_access_token');
    this.logger.warn('Token marked as invalid (circuit-breaker ON). getAccessToken() will return null until a new token is stored.');
  }

  // ---------------------------------------------------------------------------
  // Token validation via a lightweight Fyers API call
  // ---------------------------------------------------------------------------

  /**
   * Makes one cheap Fyers API call (profile endpoint) to confirm the token works.
   * Returns true if Fyers accepts it.
   */
  private async validateTokenWithFyers(token: string): Promise<boolean> {
    try {
      const response = await axios.get('https://api-t1.fyers.in/api/v3/profile', {
        headers: { Authorization: `${this.appId}:${token}` },
        timeout: 5000,
      });
      return response.data?.s === 'ok';
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns the current Fyers access token using a two-level cache:
   *
   *   Level 1 — in-memory Map  (zero I/O, returned immediately on every hot call)
   *   Level 2 — Redis          (one-time fetch → validate with Fyers API → promote to memory)
   */
  async getAccessToken(): Promise<string | null> {
    // --- Circuit-breaker: token previously confirmed bad, don't retry Redis ---
    if (this.tokenInvalid) {
      return null;
    }

    // --- Level 1: memory cache (fast path, zero I/O) ---
    const cached = this.getFromMemory();
    if (cached) {
      return cached;
    }

    // --- Level 2: Redis ---
    const tokenStr = await this.redisService.get('fyers_access_token');
    if (!tokenStr) return null;

    const token = tokenStr.toString();

    // JWT expiry pre-check (no network needed)
    try {
      const payloadBase64 = token.split('.')[1];
      if (payloadBase64) {
        const payloadStr = Buffer.from(payloadBase64, 'base64').toString('utf-8');
        const jwtPayload = JSON.parse(payloadStr);
        const exp = jwtPayload.exp;
        // Expired or expiring within 5 minutes — don't bother validating
        if (exp && (Date.now() / 1000) > (exp - 300)) {
          this.logger.warn('Fyers access token is expired or expiring soon. Clearing from Redis.');
          await this.redisService.getClient().del('fyers_access_token');
          return null;
        }
      }
    } catch (e) {
      this.logger.error(`Error decoding Fyers JWT token: ${e}`);
    }

    // One real Fyers API call to confirm the token actually works
    this.logger.log('Validating Fyers token via API before promoting to memory cache...');
    const isValid = await this.validateTokenWithFyers(token);

    if (!isValid) {
      this.logger.error('Fyers token rejected by API. Clearing stale token from Redis and activating circuit-breaker.');
      await this.redisService.getClient().del('fyers_access_token');
      this.tokenInvalid = true; // Circuit-breaker ON — no more Redis fetches
      return null;
    }

    // Token confirmed valid — promote to memory for 16h
    this.setInMemory(token);
    return token;
  }

  // ---------------------------------------------------------------------------
  // Cron — SEBI regulation: refresh token API disabled (code -16)
  // ---------------------------------------------------------------------------

  /**
   * Runs at 8:05 AM IST daily.
   * Fyers disabled the refresh-token API per SEBI regulations.
   * Only logs a reminder; manual re-auth via /fyers/callback is required.
   */
  @Cron('5 8 * * *', { timeZone: 'Asia/Kolkata' })
  async generateDailyToken() {
    // Reset circuit-breaker at 8 AM so it re-checks Redis in case someone
    // manually stored a fresh token overnight via /fyers/callback.
    this.tokenInvalid = false;
    this.clearMemoryCache();
    this.logger.warn(
      'Daily token cron fired — Fyers refresh token API is DISABLED by SEBI. ' +
      'Circuit-breaker reset. Please log in manually via the Fyers auth URL and visit /fyers/callback to get a new token.',
    );
  }

  // ---------------------------------------------------------------------------
  // Auth-code exchange (called on manual login redirect)
  // ---------------------------------------------------------------------------

  async generateTokensFromAuthCode(authCode: string): Promise<any> {
    try {
      const payload = {
        grant_type: 'authorization_code',
        appIdHash: this.getAppIdHash(),
        code: authCode,
      };

      const response = await axios.post('https://api-t1.fyers.in/api/v3/validate-authcode', payload, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.data && response.data.s === 'ok') {
        const accessToken = response.data.access_token;
        const refreshToken = response.data.refresh_token;

        // Clear stale memory cache AND reset circuit-breaker so the new token is accepted
        this.clearMemoryCache();
        this.tokenInvalid = false;

        await this.redisService.set('fyers_access_token', accessToken, 72000); // 20 hr Redis expiry
        if (refreshToken) {
          await this.redisService.set('fyers_refresh_token', refreshToken);
        }

        this.logger.log('Successfully generated and stored tokens from auth code!');
        return response.data;
      } else {
        this.logger.error('Failed to generate tokens from auth code:', response.data);
        throw new Error(response.data.message || 'Failed to validate auth code');
      }
    } catch (error: any) {
      this.logger.error(`Error exchanging auth code: ${error.message}`);
      if (error.response && error.response.data) {
        this.logger.error(`Fyers API Error Response (Auth Code): ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getAppIdHash(): string {
    return crypto.createHash('sha256').update(`${this.appId}:${this.secretId}`).digest('hex');
  }
}


