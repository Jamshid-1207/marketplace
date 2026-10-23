import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CheckoutService } from '../application/checkout.service';
import { SubOrderService } from '../application/sub-order.service';
import { CONFIG, RUN_MODE, type Config, type RunMode } from '../config';

const KEYS_CLEANUP_MS = 60 * 60_000;

/**
 * Планировщик дедлайнов saga (ADR-0005, п. 6) раз в `CHECKOUT_TICK_MS` и очистка ключей
 * идемпотентности раз в час. Несколько инстансов order не мешают друг другу: `SKIP LOCKED`.
 */
@Injectable()
export class DeadlineScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private tickTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly checkout: CheckoutService,
    private readonly subOrders: SubOrderService,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RUN_MODE) private readonly mode: RunMode,
    private readonly log: PinoLogger,
  ) {
    this.log.setContext('deadline-scheduler');
  }

  onApplicationBootstrap(): void {
    if (this.mode !== 'server') return;
    this.tickTimer = setInterval(() => void this.tick(), this.config.CHECKOUT_TICK_MS);
    this.tickTimer.unref();
    this.cleanupTimer = setInterval(() => void this.cleanup(), KEYS_CLEANUP_MS);
    this.cleanupTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.tickTimer);
    clearInterval(this.cleanupTimer);
    await this.running;
  }

  /** Тики не накладываются: пока идёт предыдущий, новый ждёт его. */
  tick(): Promise<void> {
    this.running ??= this.checkout
      .processDeadlines()
      .then(async (processed) => {
        if (processed > 0) this.log.info({ processed }, 'обработаны просроченные saga');
        await this.subOrders.alertStaleRefunds();
      })
      .catch((err: unknown) => this.log.error({ err }, 'тик планировщика не удался'))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async cleanup(): Promise<void> {
    try {
      const deleted = await this.checkout.cleanupIdempotencyKeys();
      if (deleted > 0) this.log.info({ deleted }, 'удалены старые ключи идемпотентности');
    } catch (err) {
      this.log.warn({ err }, 'очистка ключей идемпотентности не удалась');
    }
  }
}
