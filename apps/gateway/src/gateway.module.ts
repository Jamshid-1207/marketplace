import { Inject, Injectable, Module, type DynamicModule, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule, type Claims } from '@repo/auth';
import { CONFIG, type Config } from './config';
import { ProxyController } from './proxy/proxy.controller';

/** Ключ лимита: пользователь из проверенного токена, аноним — IP (SD-02, п. 3.1). */
export function rateLimitKey(req: { claims?: Claims; ip?: string }): string {
  return req.claims ? `user:${req.claims.sub}` : `ip:${req.ip ?? 'unknown'}`;
}

/**
 * `X-Forwarded-For` — только от доверенных прокси (SD-07, решение 9): тогда `req.ip` — адрес
 * клиента витрины. Без настройки заголовок не учитывается вовсе.
 */
@Injectable()
class TrustProxy implements OnModuleInit {
  constructor(
    private readonly adapter: HttpAdapterHost,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  onModuleInit(): void {
    const trusted = this.config.TRUST_PROXY;
    this.adapter.httpAdapter.getInstance().set('trust proxy', trusted.length > 0 ? trusted : false);
  }
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
      providers: [TrustProxy],
    };
  }
}
