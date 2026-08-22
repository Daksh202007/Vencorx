import { Module } from '@nestjs/common';
import { WsGateway } from './ws-gateway.gateway';
import { RestGatewayController } from './rest-gateway.controller';
import { AngelOneModule } from '../angel-one/angel-one.module';

@Module({
  imports: [AngelOneModule],
  providers: [WsGateway],
  controllers: [RestGatewayController],
})
export class GatewayModule {}
