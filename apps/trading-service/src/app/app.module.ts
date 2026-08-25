import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma.service';
import { KafkaService } from './kafka.service';
import { TradingEngineService } from './trading-engine.service';
import { OMSController } from './oms.controller';

@Module({
  imports: [
    // Rate limit: max 30 requests per 60 seconds per IP across all OMS endpoints
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,  // 60 second window
        limit: 30,    // max 30 requests per window
      },
    ]),
  ],
  controllers: [AppController, OMSController],
  providers: [
    AppService,
    PrismaService,
    KafkaService,
    TradingEngineService,
    // Apply rate limiting globally to this service
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
