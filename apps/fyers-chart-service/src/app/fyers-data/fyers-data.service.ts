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
}
