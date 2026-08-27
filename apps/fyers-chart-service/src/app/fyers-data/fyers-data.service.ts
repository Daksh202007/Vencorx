import { Injectable, Logger } from '@nestjs/common';
import { FyersAuthService } from '../fyers-auth/fyers-auth.service';
import { TimescaleService, FyersCandle } from '../database/timescale.service';
import axios from 'axios';

@Injectable()
export class FyersDataService {
  private readonly logger = new Logger(FyersDataService.name);
  private readonly baseUrl = 'https://api-t1.fyers.in/data/history';
  private activeFetches = new Map<string, Promise<void>>();

  constructor(
    private readonly fyersAuthService: FyersAuthService,
    private readonly timescaleService: TimescaleService
  ) {}

  /**
   * Fetch historical data from Fyers and save to TimescaleDB
   * @param symbol e.g., 'NSE:SBIN-EQ'
   * @param resolution '1', '15', '240'
   * @param from Epoch timestamp in seconds or 'yyyy-mm-dd'
   * @param to Epoch timestamp in seconds or 'yyyy-mm-dd'
   */
  async fetchAndSaveHistory(symbol: string, resolution: string, from: string, to: string) {
    const fetchKey = `${symbol}-${resolution}`;

    // Request Coalescing: If a fetch for this symbol/resolution is already running (or recently finished), just wait for it!
    if (this.activeFetches.has(fetchKey)) {
      return this.activeFetches.get(fetchKey);
    }

    const fetchPromise = (async () => {
      try {
        const token = await this.fyersAuthService.getAccessToken();
        if (!token) {
          throw new Error('Fyers access token not available. Please generate it first.');
        }

        // Fyers requires date_format=1 for yyyy-mm-dd format, or 0 for epoch
        const dateFormat = from.includes('-') ? '1' : '0';

        const response = await axios.get(this.baseUrl, {
          params: {
            symbol,
            resolution,
            date_format: dateFormat,
            range_from: from,
            range_to: to,
            cont_flag: '1'
          },
          headers: {
            Authorization: `${process.env.FYERS_APP_ID}:${token}`
          }
        });

        if (response.data && response.data.s === 'ok') {
          const candles: FyersCandle[] = response.data.candles.map((c: any) => ({
            symbol,
            resolution,
            timestamp: new Date(c[0] * 1000),
            open: c[1],
            high: c[2],
            low: c[3],
            close: c[4],
            volume: c[5]
          }));

          if (candles.length > 0) {
            await this.timescaleService.saveCandles(candles);
            this.logger.log(`Successfully fetched and saved ${candles.length} historical candles for ${symbol}`);
            return candles;
          } else {
            this.logger.log(`No historical data found for ${symbol} between ${from} and ${to}`);
            return [];
          }
        } else if (response.data && response.data.s === 'no_data') {
          this.logger.log(`Fyers API returned no data for ${symbol}.`);
          return [];
        } else {
          throw new Error(response.data.message || 'Failed to fetch history');
        }
      } catch (error: any) {
        this.logger.error(`Error fetching history for ${symbol}: ${error.message}`);
        throw error;
      }
    })();

    this.activeFetches.set(fetchKey, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      // Attempt Cache: Keep the completed promise in the map for 15 seconds. 
      // This guarantees we NEVER hit the Fyers API more than once every 15 seconds per symbol!
      setTimeout(() => {
        this.activeFetches.delete(fetchKey);
      }, 15000);
    }
  }

  /**
   * Get history from DB, fallback to fetching from Fyers if not found
   */
  async getHistory(symbolRaw: string, resolution: string, from: Date, to: Date): Promise<FyersCandle[]> {
    const symbol = symbolRaw.includes(':') ? symbolRaw : `NSE:${symbolRaw}`;
    
    // Clamp future 'to' dates to the current time to prevent asking for data that doesn't exist yet
    const now = new Date();
    let clampedTo = to;
    if (to.getTime() > now.getTime()) {
      clampedTo = now;
    }
    
    // 1. Try to get data from TimescaleDB first
    let dbCandles = await this.timescaleService.getHistoricalCandles(symbol, resolution, from, clampedTo);
    
    let needsFetch = false;

    if (!dbCandles || dbCandles.length === 0) {
      needsFetch = true;
    } else {
      // Check if we are missing recent data (gap detection)
      const lastCandleTime = dbCandles[dbCandles.length - 1].timestamp.getTime();
      const expectedEnd = clampedTo.getTime();
      
      // If the last candle in DB is more than 60 minutes older than the requested end time (or 'now'),
      // it means there might be a gap (e.g. server was off, or it's just incomplete).
      // We will fetch from Fyers to ensure the chart is fully up-to-date.
      if (expectedEnd - lastCandleTime > 60 * 60 * 1000) {
        this.logger.log(`Potential data gap detected for ${symbol}. Last candle: ${new Date(lastCandleTime).toISOString()}. Fetching fresh data...`);
        needsFetch = true;
      }
    }

    if (needsFetch) {
      this.logger.log(`Fetching history from Fyers API for ${symbol}...`);
      const fromStr = Math.floor(from.getTime() / 1000).toString();
      const toStr = Math.floor(clampedTo.getTime() / 1000).toString();
      
      try {
        await this.fetchAndSaveHistory(symbol, resolution, fromStr, toStr);
        // Re-query the DB to get the complete, newly merged dataset
        dbCandles = await this.timescaleService.getHistoricalCandles(symbol, resolution, from, clampedTo);
      } catch (err: any) {
        this.logger.error(`Failed to fetch fresh history from Fyers: ${err.message}`);
        // If Fyers fails, we just fall through and return whatever we had in the DB
      }
    }

    if (dbCandles && dbCandles.length > 0) {
      this.logger.log(`Served ${dbCandles.length} candles for ${symbol} from TimescaleDB.`);
      return dbCandles;
    }

    return [];
  }

  /**
   * Throttled background fetcher for 1 year of 1m, 15m, 4h data
   * Fetches in 90-day chunks and sleeps between requests to avoid rate limits
   */
  async fetchThrottledHistory(symbol: string) {
    this.logger.log(`Starting background throttled fetch for ${symbol}...`);
    
    const now = new Date();
    
    const resolutions = ['1', '15', '240'];
    const chunkDays = 90; // 90 days max per request
    const chunkMs = chunkDays * 24 * 60 * 60 * 1000;
    
    for (const res of resolutions) {
      let currentFrom: number;
      const lastDate = await this.timescaleService.getLatestFyersCandleDate(symbol, res);
      
      if (lastDate) {
        currentFrom = lastDate.getTime();
        this.logger.log(`Found existing ${res}m data for ${symbol} up to ${lastDate.toISOString()}. Fetching missing days...`);
      } else {
        currentFrom = now.getTime() - 365 * 24 * 60 * 60 * 1000;
        this.logger.log(`No existing ${res}m data for ${symbol}. Fetching full 1 year...`);
      }

      const endTime = now.getTime();
      
      while (currentFrom < endTime) {
        let currentTo = currentFrom + chunkMs;
        if (currentTo > endTime) currentTo = endTime;
        
        const fromStr = Math.floor(currentFrom / 1000).toString();
        const toStr = Math.floor(currentTo / 1000).toString();
        
        try {
          this.logger.log(`[Throttled Fetch] ${symbol} Res: ${res}, From: ${new Date(currentFrom).toLocaleDateString()}, To: ${new Date(currentTo).toLocaleDateString()}`);
          await this.fetchAndSaveHistory(symbol, res, fromStr, toStr);
        } catch (e: any) {
          this.logger.error(`Throttled fetch error for ${symbol} res ${res}: ${e.message}`);
        }
        
        // Sleep 3 seconds between chunks to protect server and API limits
        await this.sleep(3000);
        
        currentFrom = currentTo;
      }
      
      // Extra sleep between resolutions
      await this.sleep(5000);
    }
    
    this.logger.log(`Finished background throttled fetch for ${symbol}`);
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
