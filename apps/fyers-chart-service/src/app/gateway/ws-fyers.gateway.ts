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
import { Logger, OnModuleInit } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { FyersAuthService } from '../fyers-auth/fyers-auth.service';
import { TimescaleService, FyersCandle } from '../database/timescale.service';
import { RedisService } from '../redis/redis.service';
import { FyersDataService } from '../fyers-data/fyers-data.service';
const fyersDataSocket = require('fyers-api-v3').fyersDataSocket;

interface ActiveCandleState extends FyersCandle {
  lastVolTradedToday: number;
}

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  path: '/socket.io-fyers/',
})
export class WsFyersGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  private readonly logger = new Logger(WsFyersGateway.name);
  private fyersSocket: any = null;
  private activeCandles = new Map<string, ActiveCandleState>();

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

  constructor(
    private readonly fyersAuthService: FyersAuthService,
    private readonly timescaleService: TimescaleService,
    private readonly redisService: RedisService,
    private readonly fyersDataService: FyersDataService
  ) {}

  async onModuleInit() {
    try {
      // Delay initialization slightly to allow DB/Redis connections to establish
      setTimeout(async () => {
        const activeStocks = await this.redisService.getGlobalActiveStocks();
        if (activeStocks && activeStocks.length > 0) {
          this.logger.log(`Fyers Boot Sequence: Restoring subscriptions for ${activeStocks.length} active stocks...`);
          
          await this.ensureFyersSocketConnected();

          for (const stock of activeStocks) {
            if (this.fyersSocket && this.fyersSocket.isConnected()) {
              this.logger.log(`Subscribing ${stock} to Fyers live websocket...`);
              this.fyersSocket.subscribe([stock]);
            }
          }
          this.logger.log('Fyers Boot Sequence Completed.');
        }
      }, 5000);
    } catch (e: any) {
      this.logger.error(`Failed to initialize Fyers Boot Sequence: ${e.message}`);
    }
  }

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth.token || client.handshake.query.token;
      if (!token) {
        throw new Error('No token provided');
      }
      
      const jwtSecret = process.env.JWT_PRIVATE_KEY || 'test-secret';
      jwt.verify(token, jwtSecret);
      
      this.logger.log(`Client connected: ${client.id}`);
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
    if (this.fyersSocket && this.fyersSocket.isConnected()) return;

    const token = await this.fyersAuthService.getAccessToken();
    if (!token) {
      this.logger.error('Cannot connect Fyers WS: No access token available.');
      return;
    }

    const appId = process.env.FYERS_APP_ID || '';
    const accessFormat = `${appId}:${token}`;

    this.fyersSocket = fyersDataSocket.getInstance(accessFormat, './logs', false);

    this.fyersSocket.on('connect', () => {
      this.logger.log('Connected to Fyers Data WebSocket successfully.');
      this.fyersSocket.mode(this.fyersSocket.FullMode); // Full mode for detailed candle data
    });

    this.fyersSocket.on('message', async (message: any) => {
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
      this.logger.warn('Fyers WS closed.');
      this.fyersSocket = null;
    });

    this.fyersSocket.connect();
  }

  @SubscribeMessage('subscribe_fyers_chart')
  handleSubscribe(@MessageBody() data: { symbol: string }, @ConnectedSocket() client: Socket) {
    const symbol = data.symbol;
    if (!symbol) return;
    
    this.logger.log(`Client ${client.id} subscribed to ${symbol}`);
    client.join(symbol);
    
    if (this.fyersSocket && this.fyersSocket.isConnected()) {
      this.fyersSocket.subscribe([symbol]);
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
    if (roomSize === 0 && this.fyersSocket && this.fyersSocket.isConnected()) {
      this.fyersSocket.unsubscribe([symbol]);
    }
    
    return { event: 'unsubscribed', symbol };
  }
}
