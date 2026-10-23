import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { StockService } from '../application/stock.service';
import { CONFIG, RUN_MODE, type Config, type RunMode } from '../config';

/**
 * Снятие незакреплённых резервов по TTL (SD-03, п. 5.3) раз в `RESERVE_SWEEP_MS`. Работает,
 * даже если order упал: резерв не повиснет навсегда.
 */
@Injectable()
export class ExpiryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly stock: StockService,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RUN_MODE) private readonly mode: RunMode,
    private readonly log: PinoLogger,
  ) {
    this.log.setContext('reserve-expiry');
  }

  onApplicationBootstrap(): void {
    if (this.mode !== 'server') return;
    this.timer = setInterval(() => void this.tick(), this.config.RESERVE_SWEEP_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** Проходы не накладываются: пока идёт предыдущий, новый ждёт его. */
  tick(): Promise<void> {
    this.running ??= this.stock
      .releaseExpired()
      .then(() => undefined)
      .catch((err: unknown) => this.log.error({ err }, 'снятие истёкших резервов не удалось'))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
