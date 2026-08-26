import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { FyersAuthService } from '../fyers-auth/fyers-auth.service';
import { TimescaleService, FyersCandle } from '../database/timescale.service';
import { RedisService } from '../redis/redis.service';
import { FyersDataService } from '../fyers-data/fyers-data.service';
import axios from 'axios';
const fyersDataSocket = require('fyers-api-v3').fyersDataSocket;

interface ActiveCandleState extends FyersCandle {
  lastVolTradedToday: number;
}

@WebSocketGateway({
  cors: {
    // Restrict to the known client origin — never use '*' in production
    origin: process.env.ALLOWED_ORIGIN === '*' ? true : (process.env.ALLOWED_ORIGIN?.split(',') ?? ['http://localhost:5173', 'app://-']),
    credentials: true,
  },
  path: '/socket.io-fyers/',
})
export class WsFyersGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WsFyersGateway.name);
  private fyersSocket: any = null;
  private isWsConnected = false;
  private activeCandles = new Map<string, ActiveCandleState>();
  
  // Reconnection and Dead-Man Switch State
  private reconnectAttempts = 0;
  private lastTickTime: number = 0;
  private deadManInterval: NodeJS.Timeout | null = null;
  private marketStatusInterval: NodeJS.Timeout | null = null;

  @WebSocketServer()
  server!: Server;

  private getCandleStartTime(date: Date, resolutionMinutes: number): Date {
    const d = new Date(date);
    if (resolutionMinutes === 1) {
      d.setSeconds(0, 0);
    } else if (resolutionMinutes === 15) {
      const mins = d.getMinutes();
      d.setMinutes(mins - (mins % 15), 0, 0);
    } else if (resolutionMinutes === 240) {
      const h = d.getHours();
      d.setHours(h - (h % 4), 0, 0, 0);
    }
    return d;
  }

  /**
   * Dynamically checks if the market is open using Fyers Market Status API.
   * Caches the result in Redis for 10 minutes to avoid rate-limiting.
   */
  private async isMarketOpenDynamically(): Promise<boolean> {
    if (!this.isMarketOpen()) return false; // Basic weekend/hours check first

    try {
      const cachedStatus = await this.redisService.get('fyers_market_status_cache');
      if (cachedStatus === 'CLOSED') return false;
      if (cachedStatus === 'OPEN') return true;

      const token = await this.fyersAuthService.getAccessToken();
      if (!token) return true; // Assume open if we can't check

      const appId = process.env.FYERS_APP_ID || '';
      // Fyers Market Status API (we try both common URLs to be safe)
      const url = 'https://api-t1.fyers.in/data/MarketStatus';
      
      const response = await axios.get(url, {
        headers: { 'Authorization': `${appId}:${token}` }
      });

      if (response.data && Array.isArray(response.data.marketStatus)) {
        // Look for NSE Capital Market segment
        const nseStatus = response.data.marketStatus.find((m: any) => m.exchange === 'NSE' || m.segment === 10);
        if (nseStatus && nseStatus.status === 'CLOSED') {
          await this.redisService.set('fyers_market_status_cache', 'CLOSED', 600); // 10 mins cache
          return false;
        }
      }
      
      await this.redisService.set('fyers_market_status_cache', 'OPEN', 600); // 10 mins cache
      return true;
    } catch (err: any) {
      this.logger.warn(`Failed to check Fyers Market Status API: ${err.message}. Assuming OPEN.`);
      return true; // Default to open if API fails
    }
  }

  /**
   * Checks if the Indian Stock Market is currently open (Mon-Fri, 09:15 to 15:30 IST)
   */
  private isMarketOpen(): boolean {
    const now = new Date();
    // Use manual offset for reliable checking regardless of server UTC time
    // Quick UTC to IST logic
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const isWeekend = istTime.getUTCDay() === 0 || istTime.getUTCDay() === 6;
    if (isWeekend) return false;

    const hours = istTime.getUTCHours();
    const minutes = istTime.getUTCMinutes();
    const timeInMinutes = hours * 60 + minutes;
    
    // 09:15 = 9*60 + 15 = 555
    // 15:30 = 15*60 + 30 = 930
    return timeInMinutes >= 555 && timeInMinutes <= 930;
  }

  constructor(
    private readonly fyersAuthService: FyersAuthService,
    private readonly timescaleService: TimescaleService,
    private readonly redisService: RedisService,
    private readonly fyersDataService: FyersDataService
  ) {}

  async onModuleInit() {
    try {
      // Standalone Fyers Market Status sync loop (every 5 minutes)
      this.marketStatusInterval = setInterval(async () => {
        await this.isMarketOpenDynamically();
      }, 5 * 60 * 1000);

      // Delay initialization slightly to allow DB/Redis connections to establish
      setTimeout(async () => {
        try {
          this.logger.log(`Fyers Boot Sequence: Starting connection...`);
          // Immediately run one check to populate Redis on startup
          await this.isMarketOpenDynamically();
          await this.ensureFyersSocketConnected();
        } catch (e: any) {
          this.logger.error(`Error in Fyers Boot Sequence timeout: ${e.message}`);
        }
      }, 5000);
    } catch (e: any) {
      this.logger.error(`Failed to initialize Fyers Boot Sequence: ${e.message}`);
    }
  }

  onModuleDestroy() {
    if (this.marketStatusInterval) {
      clearInterval(this.marketStatusInterval);
    }
  }

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth.token || client.handshake.query.token;
      if (!token) {
        throw new Error('No token provided');
      }

      // Verify with the RS256 PUBLIC key — same pattern as ws-gateway in chat-service
      const publicKeyEnv = process.env.JWT_PUBLIC_KEY;
      if (!publicKeyEnv) throw new Error('JWT_PUBLIC_KEY is not configured on this service');
      const publicKey = publicKeyEnv.replace(/\\n/g, '\n');

      const decoded = jwt.verify(token as string, publicKey, {
        algorithms: ['RS256'],
      }) as { id: string; email: string; role: string };

      // Attach user context to the socket for downstream use
      client.data = { userId: decoded.id, email: decoded.email };

      this.logger.log(`Client connected: ${client.id} (User: ${decoded.id})`);
      await this.ensureFyersSocketConnected();
    } catch (error: any) {
      this.logger.error(`Connection rejected: ${client.id} - ${error.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  private async ensureFyersSocketConnected() {
    if (this.fyersSocket && this.isWsConnected) return;

    const token = await this.fyersAuthService.getAccessToken();
    if (!token) {
      this.logger.error('Cannot connect Fyers WS: No access token available.');
      return;
    }

    const appId = process.env.FYERS_APP_ID || '';
    const accessFormat = `${appId}:${token}`;

    this.fyersSocket = fyersDataSocket.getInstance(accessFormat, './logs', false);

    this.fyersSocket.on('connect', async () => {
      this.isWsConnected = true;
      this.logger.log('Connected to Fyers Data WebSocket successfully.');
      this.reconnectAttempts = 0; // Reset backoff on successful connect
      this.lastTickTime = Date.now();
      this.fyersSocket.mode(this.fyersSocket.FullMode); // Full mode for detailed candle data
      
      // Start Dead-Man Switch
      if (this.deadManInterval) clearInterval(this.deadManInterval);
      this.deadManInterval = setInterval(async () => {
        const isOpen = await this.isMarketOpenDynamically();
        if (!isOpen) return; // Don't trigger on weekends/holidays/nights
        
        const quietTime = Date.now() - this.lastTickTime;
        
        // Only trigger dead-man switch if we are actually subscribed to stocks!
        const activeStocks = await this.redisService.getGlobalActiveStocks();
        if (!activeStocks || activeStocks.length === 0) {
           return; // No active stocks, so it's normal that we aren't getting ticks
        }

        if (quietTime > 60000 && this.fyersSocket) { // 60 seconds of silence during market hours
          // Changed to warn so it doesn't spam Telegram as an 'Error' unless it's critical
          this.logger.warn(`Dead-Man Switch Triggered! No ticks received for ${Math.round(quietTime/1000)}s. Forcefully reconnecting...`);
          // Force close, which will trigger the 'close' event and our auto-reconnect logic
          if (this.fyersSocket.close) {
             this.fyersSocket.close();
          } else {
             this.fyersSocket = null;
             this.ensureFyersSocketConnected();
          }
        }
      }, 30000); // Check every 30 seconds

      // Auto-subscribe to all active stocks immediately after connecting
      try {
        const activeStocks = await this.redisService.getGlobalActiveStocks();
        if (activeStocks && activeStocks.length > 0) {
          this.logger.log(`Auto-subscribing ${activeStocks.length} stocks to Fyers WS...`);
          this.fyersSocket.subscribe(activeStocks);

          // Catch-Up Backfill: Fetch missing data for today in the background to patch gaps
          this.logger.log('Triggering Catch-Up Backfill for active stocks...');
          const todayStart = new Date();
          todayStart.setHours(9, 0, 0, 0); // 9:00 AM IST approx
          const now = new Date();
          
          for (const stock of activeStocks) {
            // Non-blocking catchup for 1m, 15m, 4h
            ['1', '15', '240'].forEach(res => {
              this.fyersDataService.getHistory(stock, res, todayStart, now).catch(err => {
                this.logger.warn(`Backfill failed for ${stock} (${res}m): ${err.message}`);
              });
            });
            // Small sleep to prevent rate-limit when backfilling multiple stocks
            await new Promise(r => setTimeout(r, 600)); 
          }
        }
      } catch (e: any) {
        this.logger.error(`Failed to auto-subscribe/backfill: ${e.message}`);
      }
    });

    this.fyersSocket.on('message', async (message: any) => {
      this.lastTickTime = Date.now(); // Update dead-man switch

      // Secretly aggregate ticks into 1m, 15m, 4h candles
      if (message && message.symbol) {
        const timestamp = message.timestamp ? new Date(message.timestamp * 1000) : new Date();
        const resolutions = [1, 15, 240];
        const ltp = message.ltp || 0;
        const volTradedToday = message.vol_traded_today || 0;

        for (const res of resolutions) {
          const resStr = res.toString();
          const candleStartTime = this.getCandleStartTime(timestamp, res);
          const cacheKey = `${message.symbol}-${res}`;
          let active = this.activeCandles.get(cacheKey);

          // If no active candle, or the time boundary has crossed (new candle)
          if (!active || active.timestamp.getTime() !== candleStartTime.getTime()) {
            if (active) {
              // Old candle closed! Final save to DB
              await this.timescaleService.saveCandles([active]);
            }
            // Start new candle
            active = {
              symbol: message.symbol,
              resolution: resStr,
              timestamp: candleStartTime,
              open: ltp,
              high: ltp,
              low: ltp,
              close: ltp,
              volume: 0,
              lastVolTradedToday: volTradedToday
            };
          } else {
            // Update active candle
            active.high = Math.max(active.high, ltp);
            active.low = Math.min(active.low, ltp);
            active.close = ltp;
            if (volTradedToday >= active.lastVolTradedToday) {
              active.volume += (volTradedToday - active.lastVolTradedToday);
              active.lastVolTradedToday = volTradedToday;
            }
          }

          this.activeCandles.set(cacheKey, active);
          
          // Save to DB (Upsert) so we don't lose data on crash
          await this.timescaleService.saveCandles([active]);
          
          // Emit interval-specific real-time updates to websocket clients
          this.server.to(message.symbol).emit(`fyers_candle_update_${resStr}`, active);
        }
      }
    });

    this.fyersSocket.on('error', (message: any) => {
      this.logger.error(`Fyers WS Error: ${JSON.stringify(message)}`);
    });

    this.fyersSocket.on('close', () => {
      this.isWsConnected = false;
      if (this.deadManInterval) {
        clearInterval(this.deadManInterval);
        this.deadManInterval = null;
      }

      this.reconnectAttempts++;
      // Exponential backoff to prevent rate limit bans on holidays: 5s, 15s, 45s, 2m, 5m... max 30m
      const backoffMs = Math.min(5000 * Math.pow(3, this.reconnectAttempts - 1), 30 * 60 * 1000);
      
      this.logger.warn(`Fyers WS closed. Attempting to reconnect in ${Math.round(backoffMs/1000)} seconds (Attempt ${this.reconnectAttempts})...`);
      this.fyersSocket = null;
      
      setTimeout(() => {
        this.ensureFyersSocketConnected();
      }, backoffMs);
    });

    this.fyersSocket.connect();
  }

  @SubscribeMessage('subscribe_fyers_chart')
  handleSubscribe(@MessageBody() data: { symbol: string }, @ConnectedSocket() client: Socket) {
    const symbol = data.symbol;
    if (!symbol) return;
    
    this.logger.log(`Client ${client.id} subscribed to ${symbol}`);
    client.join(symbol);
    
    if (this.fyersSocket && this.isWsConnected) {
      try {
        this.fyersSocket.subscribe([symbol]);
      } catch (e: any) {
        this.logger.error(`Fyers WS Subscribe Error: ${e.message}`);
      }
    }
    
    return { event: 'subscribed', symbol };
  }

  @SubscribeMessage('unsubscribe_fyers_chart')
  handleUnsubscribe(@MessageBody() data: { symbol: string }, @ConnectedSocket() client: Socket) {
    const symbol = data.symbol;
    if (!symbol) return;
    
    this.logger.log(`Client ${client.id} unsubscribed from ${symbol}`);
    client.leave(symbol);
    
    // Check if anyone else is still in the room before unsubscribing from Fyers
    const roomSize = this.server.sockets.adapter.rooms.get(symbol)?.size || 0;
    if (roomSize === 0 && this.fyersSocket && this.isWsConnected) {
      try {
        this.fyersSocket.unsubscribe([symbol]);
      } catch (e: any) {
        this.logger.error(`Fyers WS Unsubscribe Error: ${e.message}`);
      }
    }
    
    return { event: 'unsubscribed', symbol };
  }
}
