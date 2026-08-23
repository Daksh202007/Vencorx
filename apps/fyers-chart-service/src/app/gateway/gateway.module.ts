import { Module } from '@nestjs/common';
import { WsFyersGateway } from './ws-fyers.gateway';
import { FyersAuthModule } from '../fyers-auth/fyers-auth.module';

@Module({
  imports: [FyersAuthModule],
  providers: [WsFyersGateway],
})
export class GatewayModule {}
