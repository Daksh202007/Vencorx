import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../redis/redis.service';
import { KafkaService } from '../kafka/kafka.service';
import { TimescaleService, StockTick, BestFiveDepth } from '../database/timescale.service';
import * as speakeasy from 'speakeasy';

// Note: smartapi-javascript does not have official types, using require
const { SmartAPI, WebSocketV2 } = require('smartapi-javascript');

@Injectable()
export class AngelOneFetchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AngelOneFetchService.name);
  
  private smartApi: any;
  private webSocket: any;
  private isConnected = false;
  
  // Map of currently subscribed tokens to symbols (used by ticks handler for performance)
  private activeTokenToSymbolMap = new Map<string, string>();
  
  // Scrip master URL
  private readonly SCRIP_MASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

  // Active subscriptions (symbols)
  private subscribedStocks = new Set<string>();

  constructor(
    private readonly redisService: RedisService,
    private readonly kafkaService: KafkaService,
    private readonly timescaleService: TimescaleService
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing Real Angel One Fetcher service');
    
    try {
      await this.downloadScripMaster();
      await this.authenticateAndConnect();
      
      // Sync active stocks from Redis
      const activeStocks = await this.redisService.getGlobalActiveStocks();
      this.logger.log(`Restoring subscriptions for ${activeStocks.length} stocks from Redis...`);
      for (const stock of activeStocks) {
        const token = await this.timescaleService.getTokenForSymbol(stock);
        if (token) {
          await this.fetchThrottledAngelHistory(stock, 'NSE', token);
          await this.subscribeStock(stock);
        } else {
          this.logger.warn(`Could not find token for ${stock} in DB during boot.`);
        }
      }
    } catch (e: any) {
      this.logger.error(`Failed to initialize Angel One service: ${e.message}`);
    }
  }

  onModuleDestroy() {
    if (this.webSocket) {
      this.webSocket.close();
    }
  }

  @Cron('30 8 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async handleDailyRestart() {
    this.logger.log('Executing daily 8:30 AM CRON job: Re-authenticating with Angel One...');
    if (this.webSocket) {
      this.webSocket.close();
      this.isConnected = false;
    }
    
    try {
      await this.authenticateAndConnect();
    } catch (e: any) {
      this.logger.error(`Daily re-authentication failed: ${e.message}`);
    }
  }

  private async downloadScripMaster() {
    this.logger.log(`Downloading Scrip Master from ${this.SCRIP_MASTER_URL}...`);
    try {
      const response = await fetch(this.SCRIP_MASTER_URL);
      const data = (await response.json()) as any[];
      
      const tokensToInsert: { symbol: string; token: string }[] = [];
      for (const item of data) {
        // Keep the exact symbol like "RELIANCE-EQ"
        if (item && item.exch_seg === 'NSE' && typeof item.symbol === 'string' && item.symbol.endsWith('-EQ')) {
          tokensToInsert.push({ symbol: item.symbol, token: item.token });
        }
      }
      this.logger.log(`Parsed ${tokensToInsert.length} NSE Equity symbols from Scrip Master. Saving to PostgreSQL...`);
      await this.timescaleService.bulkUpsertScripMaster(tokensToInsert);
    } catch (error: any) {
      this.logger.error(`Failed to download Scrip Master: ${error.message}`);
      throw error;
    }
  }

  private async authenticateAndConnect() {
    const apiKey = process.env.ANGEL_ONE_API_KEY;
    const clientId = process.env.ANGEL_ONE_CLIENT_ID;
    const password = process.env.ANGEL_ONE_PASSWORD;
    const totpSecret = process.env.ANGEL_ONE_TOTP_KEY;

    if (!apiKey || !clientId || !password || !totpSecret) {
      throw new Error('Missing Angel One credentials in environment variables.');
    }

    this.smartApi = new SmartAPI({
      api_key: apiKey,
    });

    // Generate TOTP
    const totp = speakeasy.totp({
      secret: totpSecret,
      encoding: 'base32',
    });

    this.logger.log(`Authenticating with Client ID ${clientId}...`);
    
    return new Promise((resolve, reject) => {
      this.smartApi.generateSession(clientId, password, totp)
        .then((data: any) => {
          if (data.status) {
            this.logger.log('Successfully authenticated with Angel One SmartAPI.');
            
            const jwtToken = data.data.jwtToken;
            const feedToken = data.data.feedToken;
            
            this.initializeWebSocket(clientId, jwtToken, apiKey, feedToken);
            resolve(true);
          } else {
            this.logger.error(`Authentication failed: ${data.message}`);
            reject(new Error(data.message));
          }
        })
        .catch((err: any) => {
          this.logger.error(`Error during generateSession: ${err.message}`);
          reject(err);
        });
    });
  }

  private initializeWebSocket(clientCode: string, jwtToken: string, apiKey: string, feedToken: string) {
    this.logger.log('Initializing WebSocketV2...');
    
    this.webSocket = new WebSocketV2({
      jwttoken: jwtToken,
      apikey: apiKey,
      clientcode: clientCode,
      feedtoken: feedToken,
    });

    this.webSocket.connect()
      .then(() => {
        this.logger.log('Angel One WebSocket connected successfully.');
        this.isConnected = true;
        
        // Resubscribe to currently tracked stocks after reconnection
        this.resubscribeAll();
      })
      .catch((err: any) => {
        this.logger.error(`Failed to connect WebSocket: ${err.message}`);
      });

    this.webSocket.on('tick', (receiveData: any[]) => {
      this.handleTicks(receiveData);
    });

    this.webSocket.on('close', () => {
      this.logger.warn('Angel One WebSocket closed. Will attempt reconnect or wait for next module init...');
      this.isConnected = false;
    });

    this.webSocket.on('error', (err: any) => {
      this.logger.error(`Angel One WebSocket error: ${JSON.stringify(err)}`);
    });
  }

  private handleTicks(receiveData: any[]) {
    for (const data of receiveData) {
      try {
        // Mode 3 provides Full Snap Quote including depth
        const token = data.token;
        const symbol = this.activeTokenToSymbolMap.get(token);
        
        if (!symbol) continue;

        const now = new Date();
        const ltp = data.last_traded_price ? data.last_traded_price / 100 : 0;
        
        if (ltp === 0) continue; // Skip if LTP is 0

        const depth: BestFiveDepth = {
          buy: data.best_5_buy_data ? data.best_5_buy_data.map((b: any) => ({
            price: b.price / 100,
            quantity: b.quantity,
            orders: b.no_of_orders
          })) : [],
          sell: data.best_5_sell_data ? data.best_5_sell_data.map((s: any) => ({
            price: s.price / 100,
            quantity: s.quantity,
            orders: s.no_of_orders
          })) : []
        };

        const tick: StockTick = {
          stock: symbol,
          lastTradedPrice: ltp,
          open: data.open_price_of_the_day ? data.open_price_of_the_day / 100 : ltp,
          high: data.high_price_of_the_day ? data.high_price_of_the_day / 100 : ltp,
          low: data.low_price_of_the_day ? data.low_price_of_the_day / 100 : ltp,
          close: data.closed_price ? data.closed_price / 100 : ltp,
          lastTradeQuantity: data.last_traded_quantity || 0,
          exchangeFeedTime: data.exchange_timestamp ? new Date(data.exchange_timestamp).toISOString() : now.toISOString(),
          exchangeTradeTime: data.exchange_timestamp ? new Date(data.exchange_timestamp).toISOString() : now.toISOString(),
          netChange: 0, // Calculate if needed based on close
          percentChange: 0, 
          averagePrice: data.average_traded_price ? data.average_traded_price / 100 : ltp,
          tradeVolume: data.volume_trade_for_the_day || 0,
          openInterest: data.open_interest || 0,
          lowerCircuit: data.lower_circuit_limit ? data.lower_circuit_limit / 100 : 0,
          upperCircuit: data.upper_circuit_limit ? data.upper_circuit_limit / 100 : 0,
          totalBuyingQuantity: data.total_buy_quantity || 0,
          totalSellingQuantity: data.total_sell_quantity || 0,
          fiftyTwoWeekLow: data.yearly_low_price ? data.yearly_low_price / 100 : 0,
          fiftyTwoWeekHigh: data.yearly_high_price ? data.yearly_high_price / 100 : 0,
          depth,
          timestamp: now.toISOString(),
        };

        // Calculate changes
        if (tick.close > 0) {
          tick.netChange = parseFloat((tick.lastTradedPrice - tick.close).toFixed(2));
          tick.percentChange = parseFloat(((tick.netChange / tick.close) * 100).toFixed(2));
        }

        const topic = `stock-tick-${symbol}`;
        this.kafkaService.sendMessage(topic, tick);
        this.timescaleService.saveStockTick(tick);

      } catch (err: any) {
      this.logger.error(`Error processing tick data: ${err.message}`);
      }
    }
  }

  public async subscribeStock(stock: string): Promise<boolean> {
    const token = await this.timescaleService.getTokenForSymbol(stock);
    if (!token) {
      this.logger.warn(`Cannot subscribe to ${stock}. Symbol not found in PostgreSQL Scrip Master.`);
      return false;
    }

    this.subscribedStocks.add(stock);
    this.activeTokenToSymbolMap.set(token, stock);

    if (this.isConnected && this.webSocket) {
      const reqBody = {
        correlationID: `sub-${stock}-${Date.now()}`,
        action: 1, // 1 = subscribe
        params: {
          mode: 3, // 3 = Full Snap Quote
          tokenList: [
            {
              exchangeType: 1, // 1 = NSE
              tokens: [token],
            },
          ],
        },
      };
      this.webSocket.fetchData(reqBody);
      this.logger.log(`Subscribed to live feed for ${stock} (Token: ${token})`);
    } else {
      this.logger.log(`Queued subscription for ${stock}. WebSocket not yet connected.`);
    }
    return true;
  }

  public async unsubscribeStock(stock: string) {
    if (this.subscribedStocks.has(stock)) {
      this.subscribedStocks.delete(stock);
      
      const token = await this.timescaleService.getTokenForSymbol(stock);
      if (token) {
        this.activeTokenToSymbolMap.delete(token);
        if (this.isConnected && this.webSocket) {
          const reqBody = {
            correlationID: `unsub-${stock}-${Date.now()}`,
            action: 0, // 0 = unsubscribe
            params: {
              mode: 3,
              tokenList: [
                {
                  exchangeType: 1,
                  tokens: [token],
                },
              ],
            },
          };
          this.webSocket.fetchData(reqBody);
          this.logger.log(`Unsubscribed from live feed for ${stock}`);
        }
      }
    }
  }

  private async resubscribeAll() {
    if (this.subscribedStocks.size === 0) return;
    
    this.logger.log(`Resubscribing to ${this.subscribedStocks.size} stocks...`);
    const tokens: string[] = [];
    for (const stock of this.subscribedStocks) {
      const token = await this.timescaleService.getTokenForSymbol(stock);
      if (token) {
        tokens.push(token);
        this.activeTokenToSymbolMap.set(token, stock);
      }
    }

    if (tokens.length > 0) {
      const reqBody = {
        correlationID: `resub-all-${Date.now()}`,
        action: 1,
        params: {
          mode: 3,
          tokenList: [
            {
              exchangeType: 1,
              tokens,
            },
          ],
        },
      };
      this.webSocket.fetchData(reqBody);
    }
  }

  async fetchHistoryAndAddStock(symbol: string, exchange: string): Promise<any> {
    const token = await this.timescaleService.getTokenForSymbol(symbol);
    if (!token) {
      return { success: false, error: `Token not found for symbol ${symbol} in PostgreSQL database.` };
    }

    // Trigger background throttled fetch asynchronously so it doesn't block
    this.fetchThrottledAngelHistory(symbol, exchange, token).catch(e => {
      this.logger.error(`Background fetch failed for ${symbol}: ${e.message}`);
    });
    
    this.logger.log(`Subscribing to live feed for ${symbol}...`);
    
    const subscribed = await this.subscribeStock(symbol);
    
    if (subscribed) {
      await this.redisService.addSocketToStock('admin', symbol);
      return {
        success: true,
        message: `Successfully subscribed stock "${symbol}" to real Angel One WebSocket. Historical daily data fetching started in background.`,
      };
    } else {
      return { success: false, error: 'Failed to subscribe' };
    }
  }

  /**
   * Throttled background fetcher for 5 years of daily Angel One data
   */
  async fetchThrottledAngelHistory(symbol: string, exchange: string, token: string) {
    if (!this.smartApi) return;
    
    this.logger.log(`Starting background throttled fetch for Angel One ${symbol}...`);
    
    const now = new Date();
    let currentFrom: number;
    
    // Check if we have data already
    const lastDate = await this.timescaleService.getLatestAngelCandleDate(symbol);
    
    if (lastDate) {
      // Start from the last saved date
      currentFrom = lastDate.getTime();
      this.logger.log(`Found existing data for ${symbol} up to ${lastDate.toISOString()}. Fetching missing days...`);
    } else {
      // 5 years ago
      currentFrom = now.getTime() - 5 * 365 * 24 * 60 * 60 * 1000;
      this.logger.log(`No existing data for ${symbol}. Fetching full 5 years...`);
    }
    
    const endTime = now.getTime();
    
    // Chunk by 365 days
    const chunkMs = 365 * 24 * 60 * 60 * 1000;
    
    while (currentFrom < endTime) {
      let currentTo = currentFrom + chunkMs;
      if (currentTo > endTime) currentTo = endTime;
      
      const fromDate = this.formatAngelDate(new Date(currentFrom));
      const toDate = this.formatAngelDate(new Date(currentTo));
      
      try {
        this.logger.log(`[Throttled Angel Fetch] ${symbol} From: ${fromDate}, To: ${toDate}`);
        const response = await this.smartApi.getCandleData({
          exchange: exchange === 'NSE' ? 'NSE' : exchange,
          symboltoken: token,
          interval: 'ONE_DAY',
          fromdate: fromDate,
          todate: toDate
        });
        
        if (response && response.status && response.data) {
          const candles = response.data.map((c: any) => ({
            symbol,
            resolution: 'ONE_DAY',
            timestamp: new Date(c[0]),
            open: c[1],
            high: c[2],
            low: c[3],
            close: c[4],
            volume: c[5]
          }));
          await this.timescaleService.saveAngelCandles(candles);
        }
      } catch (e: any) {
        this.logger.error(`Angel fetch error for ${symbol}: ${e.message}`);
      }
      
      // Sleep 2 seconds between chunks to protect server and API limits
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      currentFrom = currentTo;
    }
    this.logger.log(`Finished background throttled fetch for Angel One ${symbol}`);
  }

  private formatAngelDate(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }
}
