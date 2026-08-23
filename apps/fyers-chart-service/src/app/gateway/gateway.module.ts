import { Module } from '@nestjs/common';
import { WsFyersGateway } from './ws-fyers.gateway';
import { FyersAuthModule } from '../fyers-auth/fyers-auth.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { FyersDataModule } from '../fyers-data/fyers-data.module';

@Module({
  imports: [FyersAuthModule, DatabaseModule, RedisModule, FyersDataModule],
  providers: [WsFyersGateway],
})
export class GatewayModule {}
