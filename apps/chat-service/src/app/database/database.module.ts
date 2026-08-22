import { Module, Global } from '@nestjs/common';
import { TimescaleService } from './timescale.service';

@Global()
@Module({
  providers: [TimescaleService],
  exports: [TimescaleService],
})
export class DatabaseModule {}
