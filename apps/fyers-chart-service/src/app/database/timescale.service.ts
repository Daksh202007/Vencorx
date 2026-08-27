import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';

export interface FyersCandle {
  symbol: string;
  resolution: string; // '1', '15', '240', etc.
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FyersTick {
  symbol: string;
  timestamp: Date;
  ltp: number;
  open_price: number;
  high_price: number;
  low_price: number;
  close_price: number;
  volume: number;
  raw_message?: any;
}

@Injectable()
export class TimescaleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimescaleService.name);
  private pool: Pool | null = null;
  public isConnected = false;
  
  async onModuleInit() {
    const connectionString = process.env.TIMESCALE_URL || process.env.DATABASE_URL;
    
    if (connectionString && (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://'))) {
      this.logger.log(`Connecting to TimescaleDB/PostgreSQL at ${connectionString.split('@')[1] || connectionString}`);
      this.pool = new Pool({ connectionString });
      
      try {
        await this.pool.query('SELECT NOW()');
        this.isConnected = true;
        this.logger.log('TimescaleDB connection verified successfully.');
        await this.initializeTables();
      } catch (err: any) {
        this.logger.warn(`Could not connect to TimescaleDB: ${err.message}.`);
        this.isConnected = false;
      }
    } else {
      this.logger.warn('No PostgreSQL/TimescaleDB connection URL provided.');
    }
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('TimescaleDB pool closed.');
    }
  }

  private async initializeTables() {
    if (!this.pool || !this.isConnected) return;

    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS fyers_candles (
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
          SELECT create_hypertable('fyers_candles', 'timestamp', if_not_exists => TRUE);
        `);
        this.logger.log('TimescaleDB hypertable successfully verified/created for fyers_candles.');
      } catch (e: any) {
        this.logger.log('TimescaleDB extension not active/installed. Running on standard PostgreSQL table.');
      }

      // Create fyers_ticks table for live websocket data
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS fyers_ticks (
          symbol VARCHAR(50) NOT NULL,
          timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
          ltp NUMERIC NOT NULL,
          open_price NUMERIC,
          high_price NUMERIC,
          low_price NUMERIC,
          close_price NUMERIC,
          volume BIGINT,
          raw_message JSONB,
          PRIMARY KEY (symbol, timestamp)
        );
      `);

      // Try turning it into a hypertable
      try {
        await this.pool.query(`
          SELECT create_hypertable('fyers_ticks', 'timestamp', if_not_exists => TRUE);
        `);
        this.logger.log('TimescaleDB hypertable successfully verified/created for fyers_ticks.');
      } catch (e: any) {
        // Ignored, might be standard PG
      }
      
      this.logger.log('Database tables successfully initialized.');
    } catch (err: any) {
      this.logger.error(`Failed to initialize database tables: ${err.message}`);
    }
  }

  async saveCandles(candles: FyersCandle[]): Promise<void> {
    if (!this.pool || !this.isConnected || candles.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const candle of candles) {
        await client.query(
          `INSERT INTO fyers_candles (
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
      this.logger.error(`Database write failed for fyers candles: ${err.message}`);
    } finally {
      client.release();
    }
  }

  async saveFyersTick(tick: FyersTick): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    try {
      await this.pool.query(
        `INSERT INTO fyers_ticks (
          symbol, timestamp, ltp, open_price, high_price, low_price, close_price, volume, raw_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (symbol, timestamp) DO NOTHING`,
        [
          tick.symbol, tick.timestamp, tick.ltp, tick.open_price,
          tick.high_price, tick.low_price, tick.close_price, tick.volume, tick.raw_message
        ]
      );
    } catch (err: any) {
      this.logger.error(`Failed to save Fyers tick for ${tick.symbol}: ${err.message}`);
    }
  }

  async getHistoricalCandles(symbol: string, resolution: string, from: Date, to: Date): Promise<FyersCandle[]> {
    if (!this.pool || !this.isConnected) return [];

    try {
      const result = await this.pool.query(
        `SELECT 
          symbol, resolution, open_price as "open", high_price as "high",
          low_price as "low", close_price as "close", volume, timestamp
        FROM fyers_candles 
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
      this.logger.error(`Database read failed for historical candles: ${err.message}`);
      return [];
    }
  }

  /**
   * Get all distinct symbols currently stored in the database
   */
  async getDistinctSymbols(): Promise<string[]> {
    if (!this.pool || !this.isConnected) return [];

    try {
      const result = await this.pool.query(
        `SELECT DISTINCT symbol FROM fyers_candles`
      );
      
      return result.rows.map(row => row.symbol);
    } catch (err: any) {
      this.logger.error(`Failed to fetch distinct symbols: ${err.message}`);
      return [];
    }
  }

  /**
   * Get the latest timestamp for Fyers candles for a specific symbol and resolution
   */
  async getLatestFyersCandleDate(symbol: string, resolution: string): Promise<Date | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        `SELECT timestamp 
         FROM fyers_candles 
         WHERE symbol = $1 AND resolution = $2
         ORDER BY timestamp DESC 
         LIMIT 1`,
        [symbol, resolution]
      );
      
      if (result.rows.length > 0) {
        return new Date(result.rows[0].timestamp);
      }
      return null;
    } catch (err: any) {
      this.logger.error(`Failed to fetch latest fyers candle date for ${symbol} (${resolution}): ${err.message}`);
      return null;
    }
  }

  /**
   * Data Retention Policy: Run every Sunday at 3:00 AM
   * Deletes 1-minute ('1') candles older than 6 months to save disk space.
   * 15m and 4h candles are retained forever for long-term historical analysis.
   */
  @Cron('0 3 * * 0')
  async enforceRetentionPolicy() {
    if (!this.pool || !this.isConnected) return;

    this.logger.log('Starting Database Retention Policy cleanup...');
    try {
      const query = `
        DELETE FROM fyers_candles 
        WHERE resolution = '1' 
        AND timestamp < NOW() - INTERVAL '6 months';
      `;
      const result = await this.pool.query(query);
      this.logger.log(`Retention Policy: Deleted ${result.rowCount} old 1-minute candles (older than 6 months).`);
    } catch (err: any) {
      this.logger.error(`Failed to enforce retention policy: ${err.message}`);
    }
  }
}
