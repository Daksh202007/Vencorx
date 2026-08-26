import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AppController } from './app.controller';
import { FyersInternalController } from './fyers-internal.controller';
import { AppService } from './app.service';
import { TelegramLoggerService } from './telegram-logger.service';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { FyersAuthModule } from './fyers-auth/fyers-auth.module';
import { FyersDataModule } from './fyers-data/fyers-data.module';
import { GatewayModule } from './gateway/gateway.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    RedisModule,
    FyersAuthModule,
    FyersDataModule,
    GatewayModule,
  ],
  controllers: [AppController, FyersInternalController],
  providers: [AppService, TelegramLoggerService],
})
export class AppModule {}
