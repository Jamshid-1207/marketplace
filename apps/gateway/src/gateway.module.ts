import { Module, type DynamicModule } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule, type Claims } from '@repo/auth';
import type { Config } from './config';
import { ProxyController } from './proxy/proxy.controller';

/** Ключ лимита: пользователь из проверенного токена, аноним — IP (SD-02, п. 3.1). */
export function rateLimitKey(req: { claims?: Claims; ip?: string }): string {
  return req.claims ? `user:${req.claims.sub}` : `ip:${req.ip ?? 'unknown'}`;
}

/**
 * Маршруты, JWT и лимит. Тело запроса gateway не разбирает (`bodyParser: false`): прокси
 * передаёт его потоком. Ключи JWT — из JWKS сервиса auth (SD-05, п. 5.2).
 */
@Module({})
export class GatewayModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: GatewayModule,
      imports: [
        AuthModule.forRoot({ jwksUrl: config.JWKS_URL }),
        // в памяти: пока gateway один, Redis не нужен (SD-00, п. 2)
        ThrottlerModule.forRoot({
          throttlers: [{ ttl: 60_000, limit: config.RATE_LIMIT_PER_MINUTE }],
          getTracker: (req) => rateLimitKey(req),
        }),
      ],
      controllers: [ProxyController],
    };
  }
}
