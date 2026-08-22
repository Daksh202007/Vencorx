import { Module } from '@nestjs/common';
import { AngelOneFetchService } from './angel-one-fetch.service';

@Module({
  providers: [AngelOneFetchService],
  exports: [AngelOneFetchService],
})
export class AngelOneModule {}
