import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function serve(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config), {
    bufferLogs: true,
    // тело проксируется потоком как есть: разбор его бы поглотил (и сломал подпись webhook)
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks(); // SIGTERM: закрыть соединения
  await app.listen(config.PORT);
}

serve().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
