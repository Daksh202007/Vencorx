import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma.service';
import { KafkaService } from './kafka.service';
import { TradingEngineService } from './trading-engine.service';
import { OMSController } from './oms.controller';

@Module({
  imports: [],
  controllers: [AppController, OMSController],
  providers: [AppService, PrismaService, KafkaService, TradingEngineService],
})
export class AppModule {}
