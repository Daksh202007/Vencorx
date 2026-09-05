import { Controller, Get, Query, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { TimescaleService } from './database/timescale.service';
import axios from 'axios';

@Controller('stocks')
export class StocksController {
  private readonly logger = new Logger(StocksController.name);

  constructor(private readonly timescaleService: TimescaleService) {}

  @Get('search')
  async searchStocks(
    @Query('q') query: string,
    @Query('exchange') exchange?: string
  ) {
    if (!query || query.length < 2) {
      throw new HttpException('Query must be at least 2 characters long', HttpStatus.BAD_REQUEST);
    }

    try {
      const results = await this.timescaleService.searchSymbols(query, exchange);
      return {
        status: 'success',
        data: results
      };
    } catch (error: any) {
      throw new HttpException({
        status: 'error',
        message: error.message
      }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('sync-test')
  async syncSymbolMaster() {
    this.logger.log('Starting manual sync of Fyers Symbol Master...');
    const urls = [
      { url: 'https://public.fyers.in/sym_details/NSE_CM.csv', exchange: 'NSE' },
      { url: 'https://public.fyers.in/sym_details/BSE_CM.csv', exchange: 'BSE' }
    ];

    let totalSaved = 0;

    for (const { url, exchange } of urls) {
      try {
        this.logger.log(`Downloading ${exchange} master from ${url}...`);
        const response = await axios.get(url, { responseType: 'text' });
        const lines = response.data.split('\n');
        
        let batch = [];
        const batchSize = 1000;
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          
          const parts = line.split(',');
          if (parts.length >= 10) {
            const fytoken = parts[0].trim();
            const name = parts[1].trim();
            const symbol = parts[9].trim();
            
            if (fytoken && symbol) {
              batch.push({ fytoken, symbol, name, exchange });
            }
          }
          
          if (batch.length === batchSize) {
            await this.timescaleService.upsertSymbols(batch);
            totalSaved += batch.length;
            batch = [];
          }
        }
        
        if (batch.length > 0) {
          await this.timescaleService.upsertSymbols(batch);
          totalSaved += batch.length;
        }
        
        this.logger.log(`Finished processing ${exchange}.`);
      } catch (error: any) {
        this.logger.error(`Failed to sync ${exchange} master: ${error.message}`);
        throw new HttpException(`Failed to sync ${exchange}: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
      }
    }

    return {
      status: 'success',
      message: `Successfully synced ${totalSaved} symbols into the database. You can now delete this endpoint.`
    };
  }
}
