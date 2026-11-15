import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { parsePort } from './port';
import { configureApp } from './setup';

const HOST = '127.0.0.1';

function readPort(): number {
  try {
    return parsePort(process.env.PORT);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  const port = readPort();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(port, HOST);
}

void bootstrap();
