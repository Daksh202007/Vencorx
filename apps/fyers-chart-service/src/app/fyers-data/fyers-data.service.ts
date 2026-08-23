import { Injectable, Logger } from '@nestjs/common';
import { FyersAuthService } from '../fyers-auth/fyers-auth.service';
import { TimescaleService, FyersCandle } from '../database/timescale.service';
import { KafkaService } from '../kafka/kafka.service';
import axios from 'axios';

@Injectable()
export class FyersDataService {
  private readonly logger = new Logger(FyersDataService.name);
  private readonly baseUrl = 'https://api-t1.fyers.in/data/history';

  constructor(
    private readonly fyersAuthService: FyersAuthService,
    private readonly timescaleService: TimescaleService,
    private readonly kafkaService: KafkaService
  ) {}

  /**
   * Fetch historical data from Fyers and save to TimescaleDB
   * @param symbol e.g., 'NSE:SBIN-EQ'
   * @param resolution '1', '15', '240'
   * @param from Epoch timestamp in seconds or 'yyyy-mm-dd'
   * @param to Epoch timestamp in seconds or 'yyyy-mm-dd'
   */
  async fetchAndSaveHistory(symbol: string, resolution: string, from: string, to: string) {
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

        this.logger.log(`Fetched ${candles.length} candles for ${symbol} at resolution ${resolution}. Saving to DB...`);
        
        await this.timescaleService.saveCandles(candles);
        
        // Emit Kafka message for real-time frontend push
        await this.kafkaService.sendMessage(`fyers-chart-update-${symbol}-${resolution}`, {
          symbol,
          resolution,
          candles,
        });
        
        return candles;
      } else {
        this.logger.error(`Fyers API error: ${JSON.stringify(response.data)}`);
        throw new Error(response.data.message || 'Failed to fetch history');
      }
    } catch (error: any) {
      this.logger.error(`Error fetching history for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get history from DB, fallback to fetching from Fyers if not found
   */
  async getHistory(symbol: string, resolution: string, from: Date, to: Date): Promise<FyersCandle[]> {
    // First, check TimescaleDB
    const dbCandles = await this.timescaleService.getHistoricalCandles(symbol, resolution, from, to);
    
    if (dbCandles && dbCandles.length > 0) {
      this.logger.log(`Served ${dbCandles.length} candles for ${symbol} from TimescaleDB.`);
      return dbCandles;
    }

    // If no data in DB, fetch from Fyers
    this.logger.log(`No data found in TimescaleDB for ${symbol}. Fetching from Fyers API...`);
    const fromStr = Math.floor(from.getTime() / 1000).toString();
    const toStr = Math.floor(to.getTime() / 1000).toString();
    
    return await this.fetchAndSaveHistory(symbol, resolution, fromStr, toStr);
  }

  /**
   * Throttled background fetcher for 1 year of 1m, 15m, 4h data
   * Fetches in 90-day chunks and sleeps between requests to avoid rate limits
   */
  async fetchThrottledHistory(symbol: string) {
    this.logger.log(`Starting background throttled fetch for ${symbol} (1 year data)...`);
    
    const now = new Date();
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    
    const resolutions = ['1', '15', '240'];
    const chunkDays = 90; // 90 days max per request
    const chunkMs = chunkDays * 24 * 60 * 60 * 1000;
    
    for (const res of resolutions) {
      let currentFrom = oneYearAgo.getTime();
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
