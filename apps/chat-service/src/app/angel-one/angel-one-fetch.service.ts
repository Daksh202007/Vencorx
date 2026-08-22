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
  
  // Mapping for Symbol to Exchange Token (e.g. "RELIANCE" -> "32250")
  private symbolToTokenMap = new Map<string, string>();
  private tokenToSymbolMap = new Map<string, string>();
  
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
        this.subscribeStock(stock);
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

  @Cron('30 8 * * *')
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
      
      for (const item of data) {
        // Safely check properties to prevent undefined errors
        if (item && item.exch_seg === 'NSE' && typeof item.symbol === 'string' && item.symbol.endsWith('-EQ')) {
          const baseSymbol = item.symbol.replace('-EQ', '');
          this.symbolToTokenMap.set(baseSymbol, item.token);
          this.tokenToSymbolMap.set(item.token, baseSymbol);
        }
      }
      this.logger.log(`Loaded ${this.symbolToTokenMap.size} NSE Equity symbols from Scrip Master.`);
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
        const symbol = this.tokenToSymbolMap.get(token);
        
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

  public subscribeStock(stock: string): boolean {
    if (!this.symbolToTokenMap.has(stock)) {
      this.logger.warn(`Cannot subscribe to ${stock}. Symbol not found in Scrip Master.`);
      return false;
    }

    this.subscribedStocks.add(stock);

    if (this.isConnected && this.webSocket) {
      const token = this.symbolToTokenMap.get(stock);
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

  public unsubscribeStock(stock: string) {
    if (this.subscribedStocks.delete(stock) && this.isConnected && this.webSocket) {
      const token = this.symbolToTokenMap.get(stock);
      if (token) {
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

  private resubscribeAll() {
    if (this.subscribedStocks.size === 0) return;
    
    this.logger.log(`Resubscribing to ${this.subscribedStocks.size} stocks...`);
    const tokens: string[] = [];
    for (const stock of this.subscribedStocks) {
      const token = this.symbolToTokenMap.get(stock);
      if (token) tokens.push(token);
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
    // History API can also be implemented using smartApi.getCandleData
    // For now, we will just subscribe to the live feed
    
    this.logger.log(`Fetching history currently skipped, directly subscribing to live feed for ${symbol}...`);
    
    const subscribed = this.subscribeStock(symbol);

    if (subscribed) {
      await this.redisService.addSocketToStock('admin', symbol);
      return {
        success: true,
        message: `Successfully subscribed stock "${symbol}" to real Angel One WebSocket.`,
      };
    } else {
      return {
        success: false,
        message: `Could not find exchange token for "${symbol}". Check if it is a valid NSE Equity symbol.`,
      };
    }
  }
}
