import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../redis/redis.service';
import axios from 'axios';
import * as crypto from 'crypto';

@Injectable()
export class FyersAuthService implements OnModuleInit {
  private readonly logger = new Logger(FyersAuthService.name);
  private appId: string;
  private secretId: string;

  constructor(private readonly redisService: RedisService) {
    this.appId = process.env.FYERS_APP_ID || '';
    this.secretId = process.env.FYERS_SECRET_ID || '';
  }

  async onModuleInit() {
    this.logger.log('Fyers Auth Service initialized.');
    const token = await this.redisService.get('fyers_access_token');
    if (!token) {
      this.logger.warn('No Fyers access token found in Redis. Awaiting cron job or manual login.');
    }
  }

  /**
   * Run EVERY DAY at 8:05 AM IST.
   */
  @Cron('5 8 * * *', { timeZone: 'Asia/Kolkata' })
  async generateDailyToken() {
    this.logger.log('Starting daily Fyers token generation cron job...');
    try {
      const refreshToken = await this.redisService.get('fyers_refresh_token');
      
      if (!refreshToken) {
        this.logger.error('No refresh token found in Redis! Cannot automatically generate daily access token.');
        return;
      }

      const pin = process.env.FYERS_PIN || '';
      
      const payload = {
        grant_type: 'refresh_token',
        appIdHash: this.getAppIdHash(),
        refresh_token: refreshToken,
        pin: pin,
      };

      const response = await axios.post('https://api-t1.fyers.in/api/v3/validate-refresh-token', payload, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.data && response.data.s === 'ok') {
        const newAccessToken = response.data.access_token;
        await this.redisService.set('fyers_access_token', newAccessToken, 86400); // 24 hr expiry
        this.logger.log('Successfully generated and stored new daily Fyers access token!');
      } else {
        this.logger.error('Failed to generate daily access token:', response.data);
      }
    } catch (error: any) {
      this.logger.error(`Error in daily token generation cron: ${error.message}`);
    }
  }

  async getAccessToken(): Promise<string | null> {
    const token = await this.redisService.get('fyers_access_token');
    return token ? token.toString() : null;
  }

  async generateTokensFromAuthCode(authCode: string): Promise<any> {
    try {
      const payload = {
        grant_type: 'authorization_code',
        appIdHash: this.getAppIdHash(),
        code: authCode,
      };

      const response = await axios.post('https://api-t1.fyers.in/api/v3/validate-authcode', payload, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.data && response.data.s === 'ok') {
        const accessToken = response.data.access_token;
        const refreshToken = response.data.refresh_token;

        await this.redisService.set('fyers_access_token', accessToken, 86400); // 24 hr expiry
        if (refreshToken) {
          await this.redisService.set('fyers_refresh_token', refreshToken);
        }
        
        this.logger.log('Successfully generated and stored initial tokens from auth code!');
        return response.data;
      } else {
        this.logger.error('Failed to generate tokens from auth code:', response.data);
        throw new Error(response.data.message || 'Failed to validate auth code');
      }
    } catch (error: any) {
      this.logger.error(`Error exchanging auth code: ${error.message}`);
      throw error;
    }
  }

  private getAppIdHash(): string {
    return crypto.createHash('sha256').update(`${this.appId}:${this.secretId}`).digest('hex');
  }
}
