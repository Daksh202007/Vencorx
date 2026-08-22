import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Pool } from 'pg';

export interface ChatMessage {
  room: string;
  senderId: string;
  senderName: string;
  message: string;
  timestamp: string;
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
  
  // Local cache fallbacks for development convenience if PostgreSQL is offline
  private mockChatMessages: Map<string, ChatMessage[]> = new Map();
  private mockStockTicks: Map<string, StockTick[]> = new Map();

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
      this.logger.warn('No PostgreSQL/TimescaleDB connection URL provided (TIMESCALE_URL / DATABASE_URL). Running in offline/mock mode.');
    }

    this.seedMockData();
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
      
      this.logger.log('Database tables successfully initialized.');
    } catch (err: any) {
      this.logger.error(`Failed to initialize database tables: ${err.message}`);
    }
  }

  /**
   * Seed mock dataset for local execution
   */
  private seedMockData() {
    const stocks = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK'];
    const now = new Date();
    
    for (const stock of stocks) {
      const ticks: StockTick[] = [];
      let basePrice = stock === 'RELIANCE' ? 2400 : stock === 'TCS' ? 3400 : stock === 'INFY' ? 1500 : 1600;
      
      for (let i = 100; i >= 0; i--) {
        const tickTime = new Date(now.getTime() - i * 60000);
        basePrice += (Math.random() - 0.5) * 10;
        ticks.push(this.generateMockTick(stock, basePrice, tickTime));
      }
      this.mockStockTicks.set(stock, ticks);
    }
  }

  /**
   * Helper to generate a tick with all FULL Mode fields
   */
  private generateMockTick(stock: string, basePrice: number, time: Date): StockTick {
    const change = (Math.random() - 0.5) * 10;
    const ltp = parseFloat((basePrice + change).toFixed(2));
    const openVal = parseFloat((basePrice - 5).toFixed(2));
    
    const depth: BestFiveDepth = {
      buy: Array.from({ length: 5 }, (_, idx) => ({
        price: parseFloat((ltp - 0.1 * (idx + 1)).toFixed(2)),
        quantity: Math.floor(Math.random() * 200) + 10,
        orders: Math.floor(Math.random() * 5) + 1
      })),
      sell: Array.from({ length: 5 }, (_, idx) => ({
        price: parseFloat((ltp + 0.1 * (idx + 1)).toFixed(2)),
        quantity: Math.floor(Math.random() * 200) + 10,
        orders: Math.floor(Math.random() * 5) + 1
      }))
    };

    return {
      stock,
      lastTradedPrice: ltp,
      open: openVal,
      high: parseFloat((ltp + 15).toFixed(2)),
      low: parseFloat((ltp - 10).toFixed(2)),
      close: parseFloat((basePrice - 2).toFixed(2)),
      lastTradeQuantity: Math.floor(Math.random() * 50) + 1,
      exchangeFeedTime: time.toISOString(),
      exchangeTradeTime: time.toISOString(),
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
      timestamp: time.toISOString(),
    };
  }

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

    // Cache fallback
    const room = message.room;
    if (!this.mockChatMessages.has(room)) {
      this.mockChatMessages.set(room, []);
    }
    this.mockChatMessages.get(room)?.push(message);
    this.logger.log(`[Cache Save Chat] Room: ${room}, Msg: "${message.message}"`);
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

    const roomMessages = this.mockChatMessages.get(room) || [];
    return roomMessages.slice(-limit);
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

    // Cache fallback
    const stock = tick.stock;
    if (!this.mockStockTicks.has(stock)) {
      this.mockStockTicks.set(stock, []);
    }
    this.mockStockTicks.get(stock)?.push(tick);
    
    const ticks = this.mockStockTicks.get(stock) || [];
    if (ticks.length > 1000) {
      ticks.shift();
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

    const ticks = this.mockStockTicks.get(stock) || [];
    return ticks.slice(-limit);
  }
}
