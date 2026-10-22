import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule, DevTokenIssuer, type Claims } from '@repo/auth';
import { json } from 'express';
import type { Config } from './config';
import { DevLoginController } from './dev-auth/dev-login.controller';
import { JwksController } from './dev-auth/jwks.controller';
import { ProxyController } from './proxy/proxy.controller';

/** Ключ лимита: пользователь из проверенного токена, аноним — IP (SD-02, п. 3.1). */
export function rateLimitKey(req: { claims?: Claims; ip?: string }): string {
  return req.claims ? `user:${req.claims.sub}` : `ip:${req.ip ?? 'unknown'}`;
}

/**
 * Маршруты, JWT, лимит и заглушка входа. Тело запроса gateway не разбирает (`bodyParser: false`):
 * прокси передаёт его потоком. Исключение — `POST /dev/login`, его тело читает сам gateway.
 */
@Module({})
export class GatewayModule implements NestModule {
  static forRoot(config: Config, issuer: DevTokenIssuer): DynamicModule {
    return {
      module: GatewayModule,
      imports: [
        // до этапа 5 токены выпускает сам gateway: ключи берутся из памяти, без запроса к себе
        AuthModule.forRoot(
          config.JWKS_URL ? { jwksUrl: config.JWKS_URL } : { jwks: issuer.jwks() },
        ),
        // в памяти: пока gateway один, Redis не нужен (SD-00, п. 2)
        ThrottlerModule.forRoot({
          throttlers: [{ ttl: 60_000, limit: config.RATE_LIMIT_PER_MINUTE }],
          getTracker: (req) => rateLimitKey(req),
        }),
      ],
      controllers: [
        ProxyController,
        JwksController,
        ...(config.DEV_AUTH ? [DevLoginController] : []),
      ],
      providers: [{ provide: DevTokenIssuer, useValue: issuer }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(json({ limit: '10kb' })).forRoutes('dev/login');
  }
}
