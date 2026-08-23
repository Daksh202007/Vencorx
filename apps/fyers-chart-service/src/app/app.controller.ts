import { Controller, Get, Query, HttpException, HttpStatus, Res } from '@nestjs/common';
import { FyersDataService } from './fyers-data/fyers-data.service';
import { FyersAuthService } from './fyers-auth/fyers-auth.service';
import { Response } from 'express';

@Controller('api/fyers')
export class AppController {
  constructor(
    private readonly fyersDataService: FyersDataService,
    private readonly fyersAuthService: FyersAuthService
  ) {}

  @Get('callback')
  async handleCallback(@Query('auth_code') authCode: string, @Query('s') status: string, @Query('message') message: string, @Res() res: Response) {
    if (status === 'error') {
      return res.status(HttpStatus.BAD_REQUEST).send(`Fyers Auth Error: ${message}`);
    }
    
    if (!authCode) {
      return res.status(HttpStatus.BAD_REQUEST).send('Missing auth_code from Fyers');
    }

    try {
      await this.fyersAuthService.generateTokensFromAuthCode(authCode);
      return res.send('<h2>Successfully authenticated with Fyers!</h2><p>Refresh token and Access token saved to Redis. You may close this window.</p>');
    } catch (error: any) {
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(`<h2>Error generating tokens</h2><p>${error.message}</p>`);
    }
  }

  @Get('history')
  async getHistory(
    @Query('symbol') symbol: string,
    @Query('resolution') resolution: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    if (!symbol || !resolution || !from || !to) {
      throw new HttpException('Missing required query parameters: symbol, resolution, from, to', HttpStatus.BAD_REQUEST);
    }

    try {
      const fromDate = new Date(parseInt(from) * 1000);
      const toDate = new Date(parseInt(to) * 1000);
      
      const data = await this.fyersDataService.getHistory(symbol, resolution, fromDate, toDate);
      return {
        status: 'success',
        data
      };
    } catch (error: any) {
      throw new HttpException({
        status: 'error',
        message: error.message
      }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
