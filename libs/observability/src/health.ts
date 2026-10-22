import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';

/**
 * Проверка готовности: БД `SELECT 1`, подключён ли producer Kafka и т. п. Реализации живут
 * там, где есть зависимость (сервис, libs/kafka), и передаются в `ObservabilityModule.forRoot`.
 */
export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<void>;
}

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

/** Зависшая зависимость не должна вешать пробу: оркестратор ждёт ответа секунды, а не минуты. */
export const READINESS_TIMEOUT_MS = 2_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`нет ответа за ${ms} мс`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[],
  ) {}

  /** Процесс жив и отвечает. Зависимости не проверяются: иначе их сбой перезапускал бы сервис. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Готов принимать трафик: все зависимости отвечают. Иначе 503. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check(
      this.checks.map((readiness) => async () => {
        const indicator = this.indicators.check(readiness.name);
        try {
          await withTimeout(readiness.check(), READINESS_TIMEOUT_MS);
          return indicator.up();
        } catch (error) {
          return indicator.down({
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }
}
