import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CONFIG, RUN_MODE, type Config, type RunMode } from '../config';
import {
  NotificationsRepository,
  type DueNotification,
  type Outcome,
} from '../repositories/notifications.repository';
import { render } from '../templates/templates';
import { retryDelay } from './plan';

/** Почтовый транспорт. `messageId` = id письма: клиент склеит редкий дубль (решение 4 SD-06). */
export abstract class Mailer {
  abstract send(mail: {
    to: string;
    subject: string;
    text: string;
    messageId: string;
  }): Promise<void>;
}

/** Писем за один тик: остальные уйдут в следующем, сервис не замирает на большой очереди. */
const BATCH = 50;

/**
 * Отправщик писем (SD-06, п. 6.2): тик, как у outbox relay. Ошибка SMTP или неизвестный ещё
 * адресат — повтор с растущей паузой; после `NOTIFY_MAX_ATTEMPTS` — `failed` и лог.
 */
@Injectable()
export class Delivery implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;

  constructor(
    private readonly repository: NotificationsRepository,
    private readonly mailer: Mailer,
    private readonly log: PinoLogger,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RUN_MODE) private readonly mode: RunMode,
  ) {
    this.log.setContext('delivery');
  }

  onApplicationBootstrap(): void {
    if (this.mode !== 'server') return;
    this.timer = setInterval(() => {
      this.running ??= this.tick().finally(() => (this.running = undefined));
    }, this.config.NOTIFY_TICK_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** Отправляет то, чему пора уйти; возвращает число обработанных писем. */
  async tick(now = () => new Date()): Promise<number> {
    let handled = 0;
    try {
      while (
        handled < BATCH &&
        (await this.repository.deliverNext(now(), (n) => this.deliver(n, now())))
      ) {
        handled++;
      }
    } catch (err) {
      this.log.warn({ err }, 'тик отправки писем не удался');
    }
    return handled;
  }

  private async deliver(n: DueNotification, now: Date): Promise<Outcome> {
    try {
      if (!n.email) throw new Error('адресат ещё неизвестен');
      const { subject, text } = render(n.template, n.data);
      await this.mailer.send({
        to: n.email,
        subject,
        text,
        messageId: `<${n.id}@marketplace.test>`,
      });
      return { sent: true };
    } catch (err) {
      const attempts = n.attempts + 1;
      const error = err instanceof Error ? err.message : String(err);
      if (attempts >= this.config.NOTIFY_MAX_ATTEMPTS) {
        this.log.error(
          { notificationId: n.id, template: n.template, attempts, error },
          'письмо не отправлено',
        );
        return { sent: false, error, retryAt: null };
      }
      const delay = retryDelay(
        attempts,
        this.config.NOTIFY_RETRY_BASE_MS,
        this.config.NOTIFY_RETRY_MAX_MS,
      );
      return { sent: false, error, retryAt: new Date(now.getTime() + delay) };
    }
  }
}
