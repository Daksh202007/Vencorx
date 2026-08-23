import { Module } from '@nestjs/common';
import { FyersAuthService } from './fyers-auth.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [FyersAuthService],
  exports: [FyersAuthService],
})
export class FyersAuthModule {}
