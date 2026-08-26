/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);

  // Enable HTTP CORS based on ALLOWED_ORIGIN env
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  app.enableCors({
    origin: allowedOrigin === '*' ? true : (allowedOrigin?.split(',') ?? ['http://localhost:5173', 'app://-']),
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  Logger.log(
    `🚀 Application is running on: http://localhost:${port}/${globalPrefix}`,
  );
}

bootstrap();
