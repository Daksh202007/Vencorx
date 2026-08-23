import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AppController } from './app.controller';
import { AppService } from './app.service';
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
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
