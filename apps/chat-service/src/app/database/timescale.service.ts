import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Pool } from 'pg';

export interface ChatMessage {
  room: string;
  senderId: string;
  senderName: string;
  message: string;
  timestamp: string;
}

export interface AngelCandle {
  symbol: string;
  resolution: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderDepth {
  price: number;
  quantity: number;
  orders: number;
}

export interface BestFiveDepth {
  buy: OrderDepth[];
  sell: OrderDepth[];
}

export interface StockTick {
  stock: string;
  lastTradedPrice: number;
  open: number;
  high: number;
  low: number;
  close: number;
  lastTradeQuantity: number;
  exchangeFeedTime: string;
  exchangeTradeTime: string;
  netChange: number;
  percentChange: number;
  averagePrice: number;
  tradeVolume: number;
  openInterest: number;
  lowerCircuit: number;
  upperCircuit: number;
  totalBuyingQuantity: number;
  totalSellingQuantity: number;
  fiftyTwoWeekLow: number;
  fiftyTwoWeekHigh: number;
  depth: BestFiveDepth;
  timestamp: string;
}

@Injectable()
export class TimescaleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimescaleService.name);
  private pool: Pool | null = null;
  private isConnected = false;

  async onModuleInit() {
    const connectionString = process.env.TIMESCALE_URL || process.env.DATABASE_URL;
    
    // Check if it's a valid PostgreSQL connection string
    if (connectionString && (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://'))) {
      this.logger.log(`Connecting to TimescaleDB/PostgreSQL at ${connectionString.split('@')[1] || connectionString}`);
      this.pool = new Pool({ connectionString });
      
      try {
        // Test connection
        await this.pool.query('SELECT NOW()');
        this.isConnected = true;
        this.logger.log('TimescaleDB connection verified successfully.');
        await this.initializeTables();
      } catch (err: any) {
        this.logger.warn(`Could not connect to TimescaleDB: ${err.message}. Falling back to offline/mock mode.`);
        this.isConnected = false;
      }
    } else {
      this.logger.warn('No PostgreSQL/TimescaleDB connection URL provided (TIMESCALE_URL / DATABASE_URL). Check your .env file!');
    }
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('TimescaleDB pool closed.');
    }
  }

  /**
   * Create target tables and hypertables for time-series logging
   */
  private async initializeTables() {
    if (!this.pool || !this.isConnected) return;

    try {
      // Create stock ticks table with all FULL Mode fields
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS stock_ticks (
          stock VARCHAR(50) NOT NULL,
          last_traded_price NUMERIC NOT NULL,
          open_price NUMERIC,
          high_price NUMERIC,
          low_price NUMERIC,
          close_price NUMERIC,
          last_trade_quantity INT,
          exchange_feed_time TIMESTAMP,
          exchange_trade_time TIMESTAMP,
          net_change NUMERIC,
          percent_change NUMERIC,
          average_price NUMERIC,
          trade_volume BIGINT,
          open_interest BIGINT,
          lower_circuit NUMERIC,
          upper_circuit NUMERIC,
          total_buying_quantity BIGINT,
          total_selling_quantity BIGINT,
          fifty_two_week_low NUMERIC,
          fifty_two_week_high NUMERIC,
          depth JSONB,
          timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
          PRIMARY KEY (stock, timestamp)
        );
      `);

      // Try turning it into a hypertable if timescale extension is active
      try {
        await this.pool.query(`
          SELECT create_hypertable('stock_ticks', 'timestamp', if_not_exists => TRUE);
        `);
        this.logger.log('TimescaleDB hypertable successfully verified/created for stock_ticks.');
      } catch (e: any) {
        this.logger.log('TimescaleDB extension not active/installed. Running on standard PostgreSQL table.');
      }

      // Create chat history table
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id SERIAL,
          room VARCHAR(100) NOT NULL,
          sender_id VARCHAR(100) NOT NULL,
          sender_name VARCHAR(100) NOT NULL,
          message TEXT NOT NULL,
          timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id, timestamp)
        );
      `);
      
      // Create Angel One historical candles table
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS angel_candles (
          symbol VARCHAR(50) NOT NULL,
          resolution VARCHAR(10) NOT NULL,
          open_price NUMERIC NOT NULL,
          high_price NUMERIC NOT NULL,
          low_price NUMERIC NOT NULL,
          close_price NUMERIC NOT NULL,
          volume BIGINT NOT NULL,
          timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
          PRIMARY KEY (symbol, resolution, timestamp)
        );
      `);

      try {
        await this.pool.query(`
          SELECT create_hypertable('angel_candles', 'timestamp', if_not_exists => TRUE);
        `);
        this.logger.log('TimescaleDB hypertable successfully verified/created for angel_candles.');
      } catch (e: any) {
        this.logger.log('TimescaleDB extension not active/installed for angel_candles. Running on standard PostgreSQL table.');
      }
      
      // Create Scrip Master table (No hypertable needed as it's not time-series data)
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS scrip_master (
          symbol VARCHAR(50) PRIMARY KEY,
          token VARCHAR(50) NOT NULL
        );
      `);
      
      this.logger.log('Database tables successfully initialized.');
    } catch (err: any) {
      this.logger.error(`Failed to initialize database tables: ${err.message}`);
    }
  }

  // Mock data removed

  /**
   * Save a chat message to DB or fallback array
   */
  async saveChatMessage(message: ChatMessage): Promise<void> {
    if (this.pool && this.isConnected) {
      try {
        await this.pool.query(
          `INSERT INTO chat_messages (room, sender_id, sender_name, message, timestamp) 
           VALUES ($1, $2, $3, $4, $5)`,
          [message.room, message.senderId, message.senderName, message.message, new Date(message.timestamp)]
        );
        return;
      } catch (err: any) {
        this.logger.error(`Database write failed for chat message: ${err.message}`);
      }
    }
  }

  /**
   * Get chat history for a specific room from DB or fallback array
   */
  async getChatHistory(room: string, limit = 50): Promise<ChatMessage[]> {
    if (this.pool && this.isConnected) {
      try {
        const result = await this.pool.query(
          `SELECT room, sender_id as "senderId", sender_name as "senderName", message, timestamp 
           FROM chat_messages WHERE room = $1 ORDER BY timestamp DESC LIMIT $2`,
          [room, limit]
        );
        return result.rows.reverse();
      } catch (err: any) {
        this.logger.error(`Database read failed for chat history: ${err.message}`);
      }
    }

    return [];
  }

  /**
   * Log stock tick data to TimescaleDB or fallback array
   */
  async saveStockTick(tick: StockTick): Promise<void> {
    if (this.pool && this.isConnected) {
      try {
        await this.pool.query(
          `INSERT INTO stock_ticks (
            stock, last_traded_price, open_price, high_price, low_price, close_price,
            last_trade_quantity, exchange_feed_time, exchange_trade_time, net_change,
            percent_change, average_price, trade_volume, open_interest, lower_circuit,
            upper_circuit, total_buying_quantity, total_selling_quantity, fifty_two_week_low,
            fifty_two_week_high, depth, timestamp
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
          ON CONFLICT (stock, timestamp) DO NOTHING`,
          [
            tick.stock, tick.lastTradedPrice, tick.open, tick.high, tick.low, tick.close,
            tick.lastTradeQuantity, new Date(tick.exchangeFeedTime), new Date(tick.exchangeTradeTime), tick.netChange,
            tick.percentChange, tick.averagePrice, tick.tradeVolume, tick.openInterest, tick.lowerCircuit,
            tick.upperCircuit, tick.totalBuyingQuantity, tick.totalSellingQuantity, tick.fiftyTwoWeekLow,
            tick.fiftyTwoWeekHigh, JSON.stringify(tick.depth), new Date(tick.timestamp)
          ]
        );
        return;
      } catch (err: any) {
        this.logger.error(`Database write failed for stock tick: ${err.message}`);
      }
    }
  }

  /**
   * Fetch historical stock price ticks ("previous data")
   */
  async getHistoricalTicks(stock: string, limit = 100): Promise<StockTick[]> {
    if (this.pool && this.isConnected) {
      try {
        const result = await this.pool.query(
          `SELECT 
            stock, last_traded_price as "lastTradedPrice", open_price as "open", high_price as "high",
            low_price as "low", close_price as "close", last_trade_quantity as "lastTradeQuantity",
            exchange_feed_time as "exchangeFeedTime", exchange_trade_time as "exchangeTradeTime",
            net_change as "netChange", percent_change as "percentChange", average_price as "averagePrice",
            trade_volume as "tradeVolume", open_interest as "openInterest", lower_circuit as "lowerCircuit",
            upper_circuit as "upperCircuit", total_buying_quantity as "totalBuyingQuantity",
            total_selling_quantity as "totalSellingQuantity", fifty_two_week_low as "fiftyTwoWeekLow",
            fifty_two_week_high as "fiftyTwoWeekHigh", depth, timestamp
          FROM stock_ticks WHERE stock = $1 ORDER BY timestamp DESC LIMIT $2`,
          [stock, limit]
        );
        
        return result.rows.map(row => ({
          ...row,
          exchangeFeedTime: new Date(row.exchangeFeedTime).toISOString(),
          exchangeTradeTime: new Date(row.exchangeTradeTime).toISOString(),
          timestamp: new Date(row.timestamp).toISOString(),
          depth: typeof row.depth === 'string' ? JSON.parse(row.depth) : row.depth
        })).reverse();
      } catch (err: any) {
        this.logger.error(`Database read failed for historical ticks: ${err.message}`);
      }
    }

    return [];
  }

  /**
   * Save Angel One historical candles to DB
   */
  async saveAngelCandles(candles: AngelCandle[]): Promise<void> {
    if (!this.pool || !this.isConnected || candles.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const candle of candles) {
        await client.query(
          `INSERT INTO angel_candles (
            symbol, resolution, open_price, high_price, low_price, close_price, volume, timestamp
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (symbol, resolution, timestamp) DO UPDATE SET
            open_price = EXCLUDED.open_price,
            high_price = EXCLUDED.high_price,
            low_price = EXCLUDED.low_price,
            close_price = EXCLUDED.close_price,
            volume = EXCLUDED.volume`,
          [
            candle.symbol, candle.resolution, candle.open, candle.high,
            candle.low, candle.close, candle.volume, candle.timestamp
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err: any) {
      await client.query('ROLLBACK');
      this.logger.error(`Database write failed for angel candles: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get Angel One historical candles from DB
   */
  async getHistoricalAngelCandles(symbol: string, resolution: string, from: Date, to: Date): Promise<AngelCandle[]> {
    if (!this.pool || !this.isConnected) return [];

    try {
      const result = await this.pool.query(
        `SELECT 
          symbol, resolution, open_price as "open", high_price as "high",
          low_price as "low", close_price as "close", volume, timestamp
        FROM angel_candles 
        WHERE symbol = $1 AND resolution = $2 AND timestamp >= $3 AND timestamp <= $4
        ORDER BY timestamp ASC`,
        [symbol, resolution, from, to]
      );
      
      return result.rows.map(row => ({
        ...row,
        open: parseFloat(row.open),
        high: parseFloat(row.high),
        low: parseFloat(row.low),
        close: parseFloat(row.close),
        volume: parseInt(row.volume, 10),
        timestamp: new Date(row.timestamp)
      }));
    } catch (err: any) {
      this.logger.error(`Database read failed for angel historical candles: ${err.message}`);
      return [];
    }
  }

  /**
   * Get the latest timestamp for Angel One candles for a specific symbol
   */
  async getLatestAngelCandleDate(symbol: string): Promise<Date | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        `SELECT timestamp 
         FROM angel_candles 
         WHERE symbol = $1 AND resolution = 'ONE_DAY'
         ORDER BY timestamp DESC 
         LIMIT 1`,
        [symbol]
      );
      
      if (result.rows.length > 0) {
        return new Date(result.rows[0].timestamp);
      }
      return null;
    } catch (err: any) {
      this.logger.error(`Failed to fetch latest angel candle date for ${symbol}: ${err.message}`);
      return null;
    }
  }

  /**
   * Bulk UPSERT Scrip Master tokens into PostgreSQL
   */
  async bulkUpsertScripMaster(tokens: { symbol: string; token: string }[]): Promise<void> {
    if (!this.pool || !this.isConnected || tokens.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      // We will batch insert using unnest for maximum performance
      // Prepare arrays of symbols and tokens
      const symbols = tokens.map(t => t.symbol);
      const tokenVals = tokens.map(t => t.token);
      
      await client.query(`
        INSERT INTO scrip_master (symbol, token) 
        SELECT * FROM UNNEST($1::text[], $2::text[]) 
        ON CONFLICT (symbol) DO UPDATE SET token = EXCLUDED.token;
      `, [symbols, tokenVals]);
      
      await client.query('COMMIT');
      this.logger.log(`Successfully upserted ${tokens.length} tokens into scrip_master table.`);
    } catch (err: any) {
      await client.query('ROLLBACK');
      this.logger.error(`Failed to bulk upsert scrip master: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get token for a specific symbol
   */
  async getTokenForSymbol(symbol: string): Promise<string | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        'SELECT token FROM scrip_master WHERE symbol = $1',
        [symbol]
      );
      if (result.rows.length > 0) {
        return result.rows[0].token;
      }
      return null;
    } catch (err: any) {
      this.logger.error(`Failed to fetch token for symbol ${symbol}: ${err.message}`);
      return null;
    }
  }

  /**
   * Get symbol for a specific token
   */
  async getSymbolForToken(token: string): Promise<string | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        'SELECT symbol FROM scrip_master WHERE token = $1',
        [token]
      );
      if (result.rows.length > 0) {
        return result.rows[0].symbol;
      }
      return null;
    } catch (err: any) {
      this.logger.error(`Failed to fetch symbol for token ${token}: ${err.message}`);
      return null;
    }
  }
}
