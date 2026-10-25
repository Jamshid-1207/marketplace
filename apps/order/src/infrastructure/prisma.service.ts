import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { tenantAware } from '@repo/auth';
import type { ReadinessCheck } from '@repo/observability';
import { CONFIG, type Config } from '../config';
import { PrismaClient } from '../generated/prisma/client';

/** Клиент своей базы (ADR-0004, п. 4). Сгенерированные типы не выходят за infrastructure. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(CONFIG) config: Config) {
    // размер пула задаётся явно (ADR-0004, п. 5); режим магазина для кабинета — RLS (SD-09, п. 5)
    super({
      adapter: tenantAware(
        new PrismaPg({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX }),
      ),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

@Injectable()
export class DatabaseReadiness implements ReadinessCheck {
  readonly name = 'database';

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
