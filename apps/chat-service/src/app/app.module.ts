import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RedisModule } from './redis/redis.module';
import { KafkaModule } from './kafka/kafka.module';
import { DatabaseModule } from './database/database.module';
import { GatewayModule } from './gateway/gateway.module';
import { AngelOneModule } from './angel-one/angel-one.module';

@Module({
  imports: [
    RedisModule,
    KafkaModule,
    DatabaseModule,
    GatewayModule,
    AngelOneModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

