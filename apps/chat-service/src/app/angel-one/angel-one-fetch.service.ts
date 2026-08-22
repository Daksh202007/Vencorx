import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { KafkaService } from '../kafka/kafka.service';
import { TimescaleService, StockTick, BestFiveDepth } from '../database/timescale.service';

export class AngelOneWebSocket {
  public id: number;
  public subscribedStocks: Set<string> = new Set();
  
  constructor(id: number) {
    this.id = id;
  }
  
  public get count(): number {
    return this.subscribedStocks.size;
  }
  
  public isFull(): boolean {
    return this.subscribedStocks.size >= 1000;
  }
  
  public subscribe(stock: string): boolean {
    if (this.isFull()) return false;
    this.subscribedStocks.add(stock);
    return true;
  }
  
  public unsubscribe(stock: string): boolean {
    return this.subscribedStocks.delete(stock);
  }
}

@Injectable()
export class AngelOneFetchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AngelOneFetchService.name);
  private intervalId!: NodeJS.Timeout;
  private currentStockPrices: Map<string, number> = new Map();
  
  // Connection pool (maximum 3 WebSockets)
  private connections: AngelOneWebSocket[] = [];

  constructor(
    private readonly redisService: RedisService,
    private readonly kafkaService: KafkaService,
    private readonly timescaleService: TimescaleService
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing Angel One Fetcher service (Connection Pool & Rate Limiter)');
    
    // Seed initial price points
    this.currentStockPrices.set('RELIANCE', 2400);
    this.currentStockPrices.set('TCS', 3400);
    this.currentStockPrices.set('INFY', 1500);
    this.currentStockPrices.set('HDFCBANK', 1600);

    // Sync active stocks from Redis into our WebSocket connection pool
    try {
      const activeStocks = await this.redisService.getGlobalActiveStocks();
      this.logger.log(`Restoring subscriptions for ${activeStocks.length} stocks from Redis...`);
      for (const stock of activeStocks) {
        this.subscribeStock(stock);
      }
    } catch (e: any) {
      this.logger.warn(`Failed to sync active stocks from Redis on startup: ${e.message}`);
    }

    // Update active stock pricing every 2 seconds
    this.intervalId = setInterval(async () => {
      await this.fetchAndPublishTicks();
    }, 2000);
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  /**
   * Add a stock to the active WebSocket connection pool.
   * Leverages existing connections, or creates a new connection (max 3), ensuring a 1000 stock limit per connection.
   */
  public subscribeStock(stock: string): boolean {
    // Check if already subscribed
    for (const conn of this.connections) {
      if (conn.subscribedStocks.has(stock)) {
        return true;
      }
    }

    // Try finding an active connection with capacity (< 1000 stocks)
    for (const conn of this.connections) {
      if (!conn.isFull()) {
        conn.subscribe(stock);
        this.logger.log(`Subscribed stock "${stock}" to connection ${conn.id}. (Subscribed count: ${conn.count}/1000)`);
        return true;
      }
    }

    // If all existing connections are full, check if we can spin up a new connection
    if (this.connections.length < 3) {
      const newId = this.connections.length + 1;
      const newConn = new AngelOneWebSocket(newId);
      newConn.subscribe(stock);
      this.connections.push(newConn);
      this.logger.log(`Created new Angel One WebSocket connection ${newId} for stock "${stock}".`);
      return true;
    }

    this.logger.error(`Could not subscribe stock "${stock}". Absolute limit of 3000 stocks (across 3 connections) reached.`);
    return false;
  }

  /**
   * Remove a stock from the WebSocket connection pool
   */
  public unsubscribeStock(stock: string) {
    for (const conn of this.connections) {
      if (conn.unsubscribe(stock)) {
        this.logger.log(`Unsubscribed stock "${stock}" from connection ${conn.id}. (Remaining: ${conn.count}/1000)`);
        
        // Remove empty extra connections (keep connection 1 alive)
        if (conn.count === 0 && this.connections.length > 1) {
          this.connections = this.connections.filter(c => c.id !== conn.id);
          this.logger.log(`Closed empty Angel One WebSocket connection ${conn.id}.`);
        }
        break;
      }
    }
  }

  /**
   * Fetch 2000 days of history at daily interval (4 requests * 500 rows each).
   * Implements strict rate limiting: Max 3 requests per 1 second.
   */
  async fetchHistoryAndAddStock(symbol: string, exchange: string): Promise<any> {
    const totalDays = 2000;
    const limit = 500;
    const numRequests = Math.ceil(totalDays / limit); // 4 requests

    this.logger.log(`Initiating historical data fetch for stock ${symbol} (${exchange}). Requiring ${numRequests} pages of 500 candles.`);

    const promises: Promise<StockTick[]>[] = [];

    for (let i = 0; i < numRequests; i++) {
      const startOffset = i * limit;
      // Enforce rate limit: max 3 requests per second.
      // Every 3 requests, add 1.1 seconds of delay buffer.
      const delay = Math.floor(i / 3) * 1100;

      const pagePromise = (async (): Promise<StockTick[]> => {
        if (delay > 0) {
          await new Promise(r => setTimeout(r, delay));
        }

        this.logger.log(`[REST HISTORICAL API] Page ${i + 1}/${numRequests} for ${symbol} (Sent with delay: ${delay}ms)`);
        return this.generateMockCandles(symbol, startOffset, limit);
      })();

      promises.push(pagePromise);
    }

    const results = await Promise.all(promises);
    const allCandles = results.flat();

    this.logger.log(`Historical fetch complete for ${symbol}. Writing ${allCandles.length} candles to database.`);

    // Write to database
    for (const candle of allCandles) {
      await this.timescaleService.saveStockTick(candle);
    }

    // Subscribe to live feed
    const subscribed = this.subscribeStock(symbol);

    if (subscribed) {
      // Record stock as active in Redis
      await this.redisService.addSocketToStock('admin', symbol);
      return {
        success: true,
        message: `Successfully loaded 2000 days of daily history (${allCandles.length} rows) and subscribed stock "${symbol}" to WebSocket pool.`,
      };
    } else {
      return {
        success: false,
        message: `Fetched 2000 days of history but could not subscribe stock "${symbol}" because the 3000 stock limit is reached.`,
      };
    }
  }

  /**
   * Helper to generate mock daily historical candles
   */
  private generateMockCandles(stock: string, startDayOffset: number, count: number): StockTick[] {
    const candles: StockTick[] = [];
    const now = new Date();
    const basePrice = stock === 'RELIANCE' ? 2400 : stock === 'TCS' ? 3400 : stock === 'INFY' ? 1500 : 1600;

    for (let i = 0; i < count; i++) {
      const dayOffset = startDayOffset + i;
      const candleTime = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
      
      const change = (Math.random() - 0.5) * 20;
      const close = parseFloat((basePrice + change).toFixed(2));
      const open = parseFloat((basePrice - Math.random() * 5).toFixed(2));
      const high = parseFloat((Math.max(open, close) + Math.random() * 10).toFixed(2));
      const low = parseFloat((Math.min(open, close) - Math.random() * 10).toFixed(2));

      candles.push({
        stock,
        lastTradedPrice: close,
        open,
        high,
        low,
        close,
        lastTradeQuantity: 100,
        exchangeFeedTime: candleTime.toISOString(),
        exchangeTradeTime: candleTime.toISOString(),
        netChange: parseFloat((close - open).toFixed(2)),
        percentChange: parseFloat((((close - open) / open) * 100).toFixed(2)),
        averagePrice: parseFloat(((close + open) / 2).toFixed(2)),
        tradeVolume: Math.floor(Math.random() * 100000) + 10000,
        openInterest: 0,
        lowerCircuit: parseFloat((open * 0.9).toFixed(2)),
        upperCircuit: parseFloat((open * 1.1).toFixed(2)),
        totalBuyingQuantity: 0,
        totalSellingQuantity: 0,
        fiftyTwoWeekLow: parseFloat((basePrice * 0.7).toFixed(2)),
        fiftyTwoWeekHigh: parseFloat((basePrice * 1.4).toFixed(2)),
        depth: { buy: [], sell: [] },
        timestamp: candleTime.toISOString(),
      });
    }
    return candles;
  }

  /**
   * Monitor WebSocket pool and stream real-time price updates for active stocks
   */
  private async fetchAndPublishTicks() {
    try {
      const activeStocks: string[] = [];
      for (const conn of this.connections) {
        activeStocks.push(...conn.subscribedStocks);
      }

      if (activeStocks.length === 0) {
        this.logger.verbose('No active WebSocket connections in Angel One pool.');
        return;
      }

      this.logger.log(`Publishing live prices for active stocks in pool: ${activeStocks.join(', ')}`);

      for (const stock of activeStocks) {
        let basePrice = this.currentStockPrices.get(stock);
        if (!basePrice) {
          basePrice = 1000 + Math.random() * 500;
          this.currentStockPrices.set(stock, basePrice);
        }

        const changePercent = (Math.random() - 0.5) * 0.002;
        basePrice += basePrice * changePercent;
        this.currentStockPrices.set(stock, basePrice);

        const now = new Date();
        const ltp = parseFloat(basePrice.toFixed(2));
        const openVal = parseFloat((basePrice - 5).toFixed(2));

        const depth: BestFiveDepth = {
          buy: Array.from({ length: 5 }, (_, idx) => ({
            price: parseFloat((ltp - 0.1 * (idx + 1)).toFixed(2)),
            quantity: Math.floor(Math.random() * 200) + 10,
            orders: Math.floor(Math.random() * 5) + 1,
          })),
          sell: Array.from({ length: 5 }, (_, idx) => ({
            price: parseFloat((ltp + 0.1 * (idx + 1)).toFixed(2)),
            quantity: Math.floor(Math.random() * 200) + 10,
            orders: Math.floor(Math.random() * 5) + 1,
          })),
        };

        const tick: StockTick = {
          stock,
          lastTradedPrice: ltp,
          open: openVal,
          high: parseFloat((ltp + 15).toFixed(2)),
          low: parseFloat((ltp - 10).toFixed(2)),
          close: parseFloat((basePrice - 2).toFixed(2)),
          lastTradeQuantity: Math.floor(Math.random() * 50) + 1,
          exchangeFeedTime: now.toISOString(),
          exchangeTradeTime: now.toISOString(),
          netChange: parseFloat((ltp - openVal).toFixed(2)),
          percentChange: parseFloat((((ltp - openVal) / openVal) * 100).toFixed(2)),
          averagePrice: parseFloat(((ltp + openVal) / 2).toFixed(2)),
          tradeVolume: Math.floor(Math.random() * 50000) + 5000,
          openInterest: Math.floor(Math.random() * 100000) + 20000,
          lowerCircuit: parseFloat((openVal * 0.9).toFixed(2)),
          upperCircuit: parseFloat((openVal * 1.1).toFixed(2)),
          totalBuyingQuantity: Math.floor(Math.random() * 200000),
          totalSellingQuantity: Math.floor(Math.random() * 200000),
          fiftyTwoWeekLow: parseFloat((basePrice * 0.7).toFixed(2)),
          fiftyTwoWeekHigh: parseFloat((basePrice * 1.4).toFixed(2)),
          depth,
          timestamp: now.toISOString(),
        };

        const topic = `stock-tick-${stock}`;
        await this.kafkaService.sendMessage(topic, tick);
        await this.timescaleService.saveStockTick(tick);
      }
    } catch (err: any) {
      this.logger.error(`Error in Angel One fetch cycle: ${err.message}`);
    }
  }
}
