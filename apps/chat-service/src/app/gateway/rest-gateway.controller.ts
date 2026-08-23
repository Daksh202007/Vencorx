import { Controller, All, Req, Res, Get, Post, Delete, Query, Body, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TimescaleService } from '../database/timescale.service';
import { AngelOneFetchService } from '../angel-one/angel-one-fetch.service';
import { RedisService } from '../redis/redis.service';
import axios from 'axios';

@Controller()
export class RestGatewayController {
  private readonly logger = new Logger(RestGatewayController.name);
  // Target URL of the Next.js Auth Service
  private readonly authServiceBaseUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3000';

  constructor(
    private readonly timescaleService: TimescaleService,
    private readonly angelOneFetchService: AngelOneFetchService,
    private readonly redisService: RedisService
  ) {}

  /**
   * Fetch historical stock tick records from TimescaleDB
   */
  @Get('market-data/history')
  async getStockHistory(@Query('stock') stock: string) {
    if (!stock) {
      return { error: 'Query parameter "stock" is required' };
    }
    const history = await this.timescaleService.getHistoricalTicks(stock);
    return { stock, history };
  }

  /**
   * User Endpoint: Get all currently active/listed stocks
   */
  @Get('market-data/stocks')
  async getActiveStocks() {
    try {
      const activeStocks = await this.redisService.getGlobalActiveStocks();
      return { success: true, stocks: activeStocks };
    } catch (err: any) {
      this.logger.error(`Failed to fetch active stocks: ${err.message}`);
      return { success: false, error: 'Failed to fetch active stocks', details: err.message };
    }
  }

  /**
   * Admin Endpoint: Register a new stock (from NSE or BSE)
   * Fetches 2000 days of history at daily interval and registers it to the active live connection pool.
   */
  @Post('market-data/stocks')
  async addStock(@Body() body: { symbol: string; exchange: string }) {
    const { symbol, exchange } = body;
    if (!symbol || !exchange) {
      return { success: false, error: 'Parameters "symbol" and "exchange" (NSE/BSE) are required' };
    }

    try {
      // 1. This triggers Angel One Live feed + Async Background Throttled Angel Fetch
      const result = await this.angelOneFetchService.fetchHistoryAndAddStock(symbol, exchange);
      
      // 2. Trigger Fyers Async Background Throttled Fetch for 1m, 15m, 4h
      // We don't await this so the admin dashboard doesn't freeze
      axios.post('http://fyers_chart_service:3002/api/fyers/internal/fetch-all-history', { symbol })
        .catch(e => this.logger.error(`Failed to trigger Fyers fetcher for ${symbol}: ${e.message}`));

      return result;
    } catch (err: any) {
      this.logger.error(`Failed to add stock ${symbol}: ${err.message}`);
      return { success: false, error: 'Failed to process historical candles and add stock', details: err.message };
    }
  }

  /**
   * Admin Endpoint: Delete a stock from live streaming pool.
   * Unsubscribes the stock from active connection pool and Redis list, keeping historical records intact.
   */
  @Delete('market-data/stocks')
  async deleteStock(@Body() body: { symbol: string }) {
    const { symbol } = body;
    if (!symbol) {
      return { success: false, error: 'Parameter "symbol" is required' };
    }

    try {
      this.logger.log(`Unsubscribing stock "${symbol}" from streaming connections. (History remains intact)`);
      this.angelOneFetchService.unsubscribeStock(symbol);
      await this.redisService.removeGlobalActiveStock(symbol);
      return {
        success: true,
        message: `Successfully unsubscribed stock "${symbol}" from active WebSocket connections. All historical tick data has been preserved.`,
      };
    } catch (err: any) {
      this.logger.error(`Failed to delete stock ${symbol}: ${err.message}`);
      return { success: false, error: 'Failed to unsubscribe stock from connection pool', details: err.message };
    }
  }

  /**
   * Catch-all route to proxy HTTP REST auth requests directly to the Next.js auth-service
   */
  @All('auth/*')
  async proxyAuthRequest(@Req() req: Request, @Res() res: Response) {
    const targetUrl = `${this.authServiceBaseUrl}${req.originalUrl}`;
    this.logger.log(`Proxying REST Auth Request: [${req.method}] ${req.originalUrl} -> ${targetUrl}`);

    try {
      const headers = { ...req.headers } as any;
      // Remove host header to prevent SSL/host mismatch on destination server
      delete headers.host;

      const body = req.method !== 'GET' && req.method !== 'HEAD' 
        ? JSON.stringify(req.body) 
        : undefined;

      const response = await fetch(targetUrl, {
        method: req.method,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body,
      });

      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err: any) {
      this.logger.error(`Auth proxy request failed: ${err.message}`);
      res.status(500).json({ error: 'Auth gateway timeout or unavailable', details: err.message });
    }
  }
}
