import { Module } from '@nestjs/common';
import { FyersDataService } from './fyers-data.service';
import { FyersAuthModule } from '../fyers-auth/fyers-auth.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [FyersAuthModule, DatabaseModule],
  providers: [FyersDataService],
  exports: [FyersDataService],
})
export class FyersDataModule {}
