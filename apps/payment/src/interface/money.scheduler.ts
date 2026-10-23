import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { SubOrderDeliveredV1 } from '@repo/contracts';
import { ConsumerRunner } from '@repo/kafka';
import { PinoLogger } from 'nestjs-pino';
import type { FinanceReader } from '../application/finance';
import { HoldService } from '../application/hold.service';
import { PayoutService } from '../application/payout.service';
import { CONFIG, RUN_MODE, type Config, type RunMode } from '../config';
import { FINANCE_READER } from './finance.controller';

/**
 * Фоновые задачи денег (SD-04, п. 5–7): конец удержания, отправка выплат — раз в
 * `MONEY_TICK_MS`; сверка инвариантов журнала — раз в `RECONCILE_INTERVAL_MS`. Плюс подписка
 * на `sub-order.delivered` — начало удержания.
 */
@Injectable()
export class MoneyScheduler implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private tickTimer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly runner: ConsumerRunner,
    private readonly hold: HoldService,
    private readonly payouts: PayoutService,
    @Inject(FINANCE_READER) private readonly finance: FinanceReader,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RUN_MODE) private readonly mode: RunMode,
    private readonly log: PinoLogger,
  ) {
    this.log.setContext('money');
  }

  onModuleInit(): void {
    this.runner.on(SubOrderDeliveredV1, 'payment.sub-order-delivered', (e) =>
      this.hold.onDelivered(e.payload.subOrderId, new Date(e.occurredAt)),
    );
  }

  onApplicationBootstrap(): void {
    if (this.mode !== 'server') return;
    this.tickTimer = setInterval(() => void this.tick(), this.config.MONEY_TICK_MS);
    this.tickTimer.unref();
    this.reconcileTimer = setInterval(
      () => void this.reconcile(),
      this.config.RECONCILE_INTERVAL_MS,
    );
    this.reconcileTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.tickTimer);
    clearInterval(this.reconcileTimer);
    await this.running;
  }

  /** Проходы не накладываются: пока идёт предыдущий, новый ждёт его. */
  tick(): Promise<void> {
    this.running ??= (async () => {
      try {
        await this.hold.releaseDue();
        await this.payouts.sendPending();
      } catch (err) {
        this.log.error({ err }, 'проход планировщика денег не удался');
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** Расхождение — `error` с `alert`: деньги не сходятся, нужен человек (ADR-0007, п. 7). */
  async reconcile(): Promise<void> {
    try {
      const check = await this.finance.checkLedger();
      if (!check.ok) {
        this.log.error({ alert: true, problems: check.problems }, 'сверка журнала: расхождения');
      }
    } catch (err) {
      this.log.error({ err }, 'сверка журнала не удалась');
    }
  }
}
