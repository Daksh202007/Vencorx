import { Controller, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { FyersDataService } from './fyers-data/fyers-data.service';

@Controller('api/fyers/internal')
export class FyersInternalController {
  constructor(private readonly fyersDataService: FyersDataService) {}

  @Post('subscribe')
  async subscribeChartData(@Body() body: { symbol: string; resolution: string; from: string; to: string }) {
    const { symbol, resolution, from, to } = body;
    
    if (!symbol || !resolution || !from || !to) {
      throw new HttpException('Missing required parameters', HttpStatus.BAD_REQUEST);
    }

    try {
      // Convert epoch to Date objects for the service
      const fromDate = new Date(parseInt(from) * 1000);
      const toDate = new Date(parseInt(to) * 1000);

      // This will check TSDB, fallback to Fyers API, save to TSDB, and emit Kafka update
      await this.fyersDataService.getHistory(symbol, resolution, fromDate, toDate);
      
      return { success: true, message: `Subscription triggered for ${symbol} at resolution ${resolution}` };
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('fetch-all-history')
  async fetchAllHistory(@Body() body: { symbol: string }) {
    const { symbol } = body;
    
    if (!symbol) {
      throw new HttpException('Missing symbol parameter', HttpStatus.BAD_REQUEST);
    }

    // Trigger asynchronously so it doesn't block the response
    this.fyersDataService.fetchThrottledHistory(symbol).catch(e => {
      console.error(`Background fetch failed for ${symbol}:`, e);
    });

    return { 
      success: true, 
      message: `Throttled background fetching of 1-year historical data (1m, 15m, 4h) started for ${symbol}` 
    };
  }
}
