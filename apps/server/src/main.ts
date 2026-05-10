import { NestFactory } from '@nestjs/core';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  const trustProxy = process.env.TRUST_PROXY ?? 'loopback';
  const httpAdapter = app.getHttpAdapter().getInstance() as { set?: (k: string, v: unknown) => void };
  httpAdapter.set?.('trust proxy', trustProxy === 'true' ? true : trustProxy === 'false' ? false : trustProxy);
  app.use(cookieParser());
  const configuredOrigins = (process.env.CORS_ORIGIN || process.env.FRONTEND_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins = configuredOrigins.length
    ? configuredOrigins
    : ['http://localhost:5173', 'http://127.0.0.1:5173'];
  app.enableCors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('CORS origin is not allowed'));
    },
  });
  const port = process.env.SERVER_PORT || 3000;
  await app.listen(port);
  console.log(`Server running on http://localhost:${port}`);
}
bootstrap();
