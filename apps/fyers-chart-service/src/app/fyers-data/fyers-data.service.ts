import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FyersAuthService } from '../fyers-auth/fyers-auth.service';
import { TimescaleService, FyersCandle } from '../database/timescale.service';
import axios from 'axios';

@Injectable()
export class FyersDataService {
  private readonly logger = new Logger(FyersDataService.name);
  private readonly baseUrl = 'https://api-t1.fyers.in/data/history';
  private activeFetches = new Map<string, Promise<FyersCandle[]>>();

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
    const fetchKey = `${symbol}-${resolution}-${from}-${to}`;

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
   * Resolution config: max history Fyers provides + safe chunk size per resolution.
   *
   * Fyers API limits (approximate):
   *   1m  → max ~100 days history, fetch in 30-day chunks
   *   15m → max ~400 days history, fetch in 90-day chunks
   *   4H  → max ~2000 days (~5.5yr) history, fetch in 365-day chunks
   */
  private readonly RESOLUTION_CONFIG: Record<string, { maxDays: number; chunkDays: number }> = {
    '1':   { maxDays: 100,  chunkDays: 30  },
    '15':  { maxDays: 400,  chunkDays: 90  },
    '240': { maxDays: 2000, chunkDays: 365 },
  };

  /**
   * Full historical backfill for a single symbol across all resolutions.
   *
   * Strategy:
   *  1. Check the EARLIEST candle already stored in DB for this symbol+resolution.
   *  2. If no data → fetch from `now - maxDays` up to `now`.
   *  3. If some data exists → fetch from `now - maxDays` up to `earliestKnown` (fill backwards gap)
   *     AND from `latestKnown` up to `now` (fill forward gap / today's live data).
   *  4. Chunked requests with throttle sleep to stay within Fyers rate limits.
   */
  async fetchThrottledHistory(symbol: string): Promise<void> {
    const sym = symbol.includes(':') ? symbol : `NSE:${symbol}`;
    this.logger.log(`[Backfill] Starting full history backfill for ${sym}...`);

    const now = Date.now();

    for (const [res, cfg] of Object.entries(this.RESOLUTION_CONFIG)) {
      try {
        await this.backfillResolution(sym, res, cfg.maxDays, cfg.chunkDays, now);
      } catch (e: any) {
        this.logger.error(`[Backfill] Resolution ${res} failed for ${sym}: ${e.message}`);
      }
      // Extra sleep between resolutions so we don't hammer the API
      await this.sleep(5000);
    }

    this.logger.log(`[Backfill] Completed full history backfill for ${sym}.`);
  }

  /**
   * Backfill one resolution for a symbol.
   * Fetches the maximum possible history in chunks, filling both backward and forward gaps.
   */
  private async backfillResolution(
    symbol: string,
    resolution: string,
    maxDays: number,
    chunkDays: number,
    nowMs: number,
  ): Promise<void> {
    const chunkMs   = chunkDays * 24 * 60 * 60 * 1000;
    const maxFromMs = nowMs - maxDays * 24 * 60 * 60 * 1000;

    // Query DB for earliest and latest known candle
    const [earliest, latest] = await Promise.all([
      this.timescaleService.getEarliestFyersCandleDate(symbol, resolution),
      this.timescaleService.getLatestFyersCandleDate(symbol, resolution),
    ]);

    if (!earliest || !latest) {
      // No data at all — fetch from maxDays ago to now
      this.logger.log(`[Backfill] ${symbol} (${resolution}m): No existing data. Fetching max ${maxDays} days...`);
      await this.fetchChunked(symbol, resolution, maxFromMs, nowMs, chunkMs);
      return;
    }

    const earliestMs = earliest.getTime();
    const latestMs   = latest.getTime();

    // Backward gap: from maxDays-ago up to earliest known candle
    if (earliestMs > maxFromMs + chunkMs) {
      this.logger.log(`[Backfill] ${symbol} (${resolution}m): Filling backward gap from ${new Date(maxFromMs).toDateString()} to ${earliest.toDateString()}`);
      await this.fetchChunked(symbol, resolution, maxFromMs, earliestMs, chunkMs);
    } else {
      this.logger.log(`[Backfill] ${symbol} (${resolution}m): Backward history already at max (${new Date(earliestMs).toDateString()}). Skipping backward fill.`);
    }

    // Forward gap: from latest known candle up to now
    const oneChunkAgo = nowMs - chunkMs;
    if (latestMs < oneChunkAgo) {
      this.logger.log(`[Backfill] ${symbol} (${resolution}m): Filling forward gap from ${latest.toDateString()} to now...`);
      await this.fetchChunked(symbol, resolution, latestMs, nowMs, chunkMs);
    } else {
      this.logger.log(`[Backfill] ${symbol} (${resolution}m): Data is recent enough (${new Date(latestMs).toDateString()}). Skipping forward fill.`);
    }
  }

  /**
   * Fetch a date range in `chunkMs`-sized pieces with throttle sleep between requests.
   */
  private async fetchChunked(
    symbol: string,
    resolution: string,
    fromMs: number,
    toMs: number,
    chunkMs: number,
  ): Promise<void> {
    let cursor = fromMs;
    while (cursor < toMs) {
      const end = Math.min(cursor + chunkMs, toMs);
      const fromStr = Math.floor(cursor / 1000).toString();
      const toStr   = Math.floor(end   / 1000).toString();

      this.logger.log(
        `[Backfill] Fetching ${symbol} (${resolution}m): ${new Date(cursor).toDateString()} → ${new Date(end).toDateString()}`,
      );

      try {
        await this.fetchAndSaveHistory(symbol, resolution, fromStr, toStr);
      } catch (e: any) {
        this.logger.error(`[Backfill] Chunk failed ${symbol} (${resolution}m) ${fromStr}→${toStr}: ${e.message}`);
        // Continue to next chunk even if one fails
      }

      // Throttle: 3s between chunks to avoid rate-limit bans
      await this.sleep(3000);
      cursor = end;
    }
  }

  /**
   * Public entry point: trigger a full backfill for a new stock in the background.
   * Call this when a stock is subscribed for the first time.
   * Non-blocking — fires and forgets, errors are logged not thrown.
   */
  triggerFullBackfill(symbol: string): void {
    this.fetchThrottledHistory(symbol).catch(e =>
      this.logger.error(`[Backfill] Unhandled error for ${symbol}: ${e.message}`),
    );
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Daily Candle Rewrite Job
   * Runs at 4:00 PM IST (Monday - Friday) after Indian markets close.
   */
  @Cron('0 16 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async rewriteDailyCandles() {
    this.logger.log('Starting daily candle rewrite job at 4:00 PM IST...');
    const symbols = await this.timescaleService.getDistinctSymbols();
    
    if (symbols.length === 0) {
      this.logger.log('No symbols found in the database to rewrite.');
      return;
    }

    const now = new Date();
    // Get beginning of today (midnight)
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const fromStr = Math.floor(startOfDay.getTime() / 1000).toString();
    const toStr = Math.floor(now.getTime() / 1000).toString();
    
    const resolutions = ['1', '15', '240'];

    for (const symbol of symbols) {
      for (const res of resolutions) {
        try {
           this.logger.log(`Rewriting ${symbol} (${res}m) for today...`);
           await this.fetchAndSaveHistory(symbol, res, fromStr, toStr);
           await this.sleep(2000); // 2 second delay to avoid rate limits
        } catch (e: any) {
           this.logger.error(`Failed to rewrite today's candles for ${symbol} (${res}m): ${e.message}`);
        }
      }
      await this.sleep(3000); // Additional sleep between symbols
    }
    this.logger.log('Finished daily candle rewrite job.');
  }
}
