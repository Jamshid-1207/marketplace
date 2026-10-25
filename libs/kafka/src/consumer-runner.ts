import type {
  AnyMessageDefinition,
  DecodeResult,
  Envelope,
  MessageRegistry,
  PayloadOf,
} from '@repo/contracts';
import { runWithContext, runWithTraceHeaders } from '@repo/observability';
import type { Consumer, EachMessagePayload, Kafka, KafkaMessage, Message } from 'kafkajs';
import { ANY_HANDLER, describeError, dlqTopic, headersToStrings, toDlqMessage } from './dlq';
import { ConsumerStoppingError, isPermanent } from './errors';
import { readDlqToEnd, type ReprocessResult } from './dlq-reprocess';
import type { KafkaLogger } from './kafka';
import { ConsumerMetrics } from './metrics';

export interface MessageMeta {
  topic: string;
  partition: number;
  offset: string;
}

export type MessageHandler<D extends AnyMessageDefinition> = (
  envelope: Envelope<PayloadOf<D>>,
  meta: MessageMeta,
) => Promise<void>;

interface Registration {
  name: string;
  handle: MessageHandler<AnyMessageDefinition>;
}

export interface DlqSender {
  send(topic: string, messages: Message[]): Promise<void>;
}

export interface ConsumerRunnerOptions {
  kafka: Kafka;
  /** = имя сервиса: `erp-service`, `crm-service` (ADR-0002, п. 7). */
  groupId: string;
  registry: MessageRegistry;
  dlq: DlqSender;
  logger: KafkaLogger;
  /** Параллельно обрабатываемых партиций; внутри партиции — строго по одному. */
  partitionsConsumedConcurrently?: number;
  /** Паузы между попытками временной ошибки; их число — число повторов (ADR-0002, п. 8). */
  retryDelaysMs?: readonly number[];
  /** Читать новую группу с начала топика. Сервисы — нет; тесты и replay — да. */
  fromBeginning?: boolean;
  /**
   * Топики, которые новая группа всегда читает с начала: события-состояния для read-моделей
   * (`catalog.events`, SD-05, п. 7). Иначе группа, созданная позже публикации, их не увидит.
   */
  fromBeginningTopics?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** Не дольше этого между heartbeat во время паузы: иначе consumer выпадет из группы. */
const HEARTBEAT_SLICE_MS = 1_000;

/**
 * Consumer runner (ADR-0002, п. 7–8; SD-01, п. 6.5). На каждое сообщение: разбор конверта →
 * схема его версии → upcast → контекст цепочки и трейса → обработчики этого типа по очереди →
 * commit offset. Каждый обработчик ретраится и уходит в DLQ отдельно.
 */
export class ConsumerRunner {
  private readonly handlers = new Map<string, Registration[]>();
  private readonly options: Required<Omit<ConsumerRunnerOptions, 'sleep'>> & {
    sleep: (ms: number) => Promise<void>;
  };
  private consumer?: Consumer;
  private stopping = false;
  private readonly metrics: ConsumerMetrics;

  constructor(options: ConsumerRunnerOptions) {
    this.options = {
      partitionsConsumedConcurrently: 3,
      retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
      fromBeginning: false,
      fromBeginningTopics: [],
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...options,
    };
    this.metrics = new ConsumerMetrics(this.options.groupId);
  }

  get dlqTopic(): string {
    return dlqTopic(this.options.groupId);
  }

  /** Топики, на которые подписан runner: топики зарегистрированных типов. */
  get topics(): string[] {
    const topics = new Set<string>();
    for (const type of this.handlers.keys()) {
      topics.add((this.options.registry.latest(type) as AnyMessageDefinition).topic);
    }
    return [...topics];
  }

  /**
   * Регистрирует обработчик. `name` — ключ в `processed_events` и в заголовке `x-handler`,
   * поэтому стабилен и уникален в сервисе: `crm.ltv`, `crm.timeline`.
   */
  on<D extends AnyMessageDefinition>(definition: D, name: string, handle: MessageHandler<D>): this {
    // обработчик работает только с последней версией: старые приводятся upcaster'ами
    if (this.options.registry.latest(definition.type) !== definition) {
      throw new Error(
        `${name}: ${definition.type} v${definition.version} — не последняя версия в реестре`,
      );
    }
    if ([...this.handlers.values()].flat().some((r) => r.name === name)) {
      throw new Error(`обработчик ${name} уже зарегистрирован`);
    }
    const registrations = this.handlers.get(definition.type) ?? [];
    registrations.push({ name, handle: handle as MessageHandler<AnyMessageDefinition> });
    this.handlers.set(definition.type, registrations);
    return this;
  }

  async start(): Promise<void> {
    const { kafka, groupId, partitionsConsumedConcurrently, fromBeginning, fromBeginningTopics } =
      this.options;
    this.stopping = false;
    // сервис без обработчиков (например, только публикует) не подписывается ни на что
    if (this.handlers.size === 0) {
      this.options.logger.info({ groupId }, 'обработчиков нет, consumer не запускается');
      return;
    }
    this.consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false });
    await this.consumer.connect();
    const fromStart = this.topics.filter((t) => fromBeginningTopics.includes(t));
    const rest = this.topics.filter((t) => !fromBeginningTopics.includes(t));
    // начальная позиция новой группы задаётся на топик: отдельная подписка на каждую группу топиков
    if (fromStart.length > 0) {
      await this.consumer.subscribe({ topics: fromStart, fromBeginning: true });
    }
    if (rest.length > 0) await this.consumer.subscribe({ topics: rest, fromBeginning });
    // eachMessage: внутри партиции строго по одному, параллельной обработки нет (ADR-0002, п. 7)
    await this.consumer.run({
      partitionsConsumedConcurrently,
      eachMessage: (payload) => this.handle(payload),
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.consumer?.disconnect();
    this.consumer = undefined;
  }

  /**
   * Обработка одного сообщения. Возврат без ошибки — offset можно коммитить: сообщение
   * обработано, пропущено или отправлено в DLQ. Ошибка — offset не коммитится.
   */
  async handle({ topic, partition, message, heartbeat }: EachMessagePayload): Promise<void> {
    const meta: MessageMeta = { topic, partition, offset: message.offset };

    let decoded: DecodeResult;
    try {
      decoded = this.options.registry.decode(JSON.parse(message.value?.toString() ?? ''));
    } catch (error) {
      const started = performance.now();
      await this.toDlq(message, meta, ANY_HANDLER, error, 1);
      this.metrics.processed(topic, ANY_HANDLER, 'dlq', started);
      return;
    }

    // в топике контекста лежат и сообщения для других потребителей — это не ошибка
    const registrations =
      decoded.status === 'decoded' ? (this.handlers.get(decoded.definition.type) ?? []) : [];
    if (registrations.length === 0) {
      this.options.logger.debug(
        { ...meta, type: decoded.envelope.type },
        'тип не обрабатывается, пропуск',
      );
      return;
    }

    const { envelope } = decoded;
    const traceHeaders = headersToStrings(message.headers);
    for (const registration of registrations) {
      await runWithContext(
        { correlationId: envelope.correlationId, causationId: envelope.eventId },
        () =>
          runWithTraceHeaders(traceHeaders, () =>
            this.runWithRetries(registration, envelope, message, meta, heartbeat),
          ),
      );
    }
  }

  private async runWithRetries(
    registration: Registration,
    envelope: Envelope,
    message: KafkaMessage,
    meta: MessageMeta,
    heartbeat: () => Promise<void>,
  ): Promise<void> {
    const delays = this.options.retryDelaysMs;
    const started = performance.now();
    for (let attempt = 1; ; attempt++) {
      try {
        await registration.handle(envelope, meta);
        this.metrics.processed(meta.topic, registration.name, 'processed', started);
        return;
      } catch (error) {
        if (isPermanent(error) || attempt > delays.length) {
          await this.toDlq(message, meta, registration.name, error, attempt);
          this.metrics.processed(meta.topic, registration.name, 'dlq', started);
          return;
        }
        this.metrics.retried(meta.topic, registration.name);
        this.options.logger.warn(
          { ...meta, handler: registration.name, attempt, err: error },
          'временная ошибка обработчика, повтор',
        );
        // перебалансировка или остановка прерывают паузу ошибкой: без DLQ, сообщение придёт снова
        await this.pauseWithHeartbeat(delays[attempt - 1], heartbeat);
      }
    }
  }

  /** Пауза кусками с heartbeat: партиция стоит осознанно, ради порядка (ADR-0002, п. 8). */
  private async pauseWithHeartbeat(ms: number, heartbeat: () => Promise<void>): Promise<void> {
    for (let left = ms; left > 0; left -= HEARTBEAT_SLICE_MS) {
      await this.options.sleep(Math.min(left, HEARTBEAT_SLICE_MS));
      if (this.stopping) throw new ConsumerStoppingError();
      await heartbeat(); // при перебалансировке kafkajs бросает ошибку и сам переподключается
    }
  }

  /** Отправка в DLQ напрямую, мимо outbox. Не получилось — ошибка, offset не коммитится. */
  private async toDlq(
    message: KafkaMessage,
    meta: MessageMeta,
    handler: string,
    error: unknown,
    attempts: number,
  ): Promise<void> {
    const source = { topic: meta.topic, partition: meta.partition, groupId: this.options.groupId };
    await this.options.dlq.send(this.dlqTopic, [
      toDlqMessage(message, source, handler, error, attempts),
    ]);
    this.options.logger.error(
      { ...meta, handler, attempts, err: error, dlq: this.dlqTopic },
      'сообщение отправлено в DLQ',
    );
  }

  /**
   * Повторная обработка DLQ своей группы после исправления (ADR-0002, п. 8; SD-01, п. 6.5).
   * Читает DLQ группой `<group>.dlq-reprocess` до конца, запомненного при старте, и завершается.
   */
  reprocessDlq({ timeoutMs = 60_000 } = {}): Promise<ReprocessResult> {
    return readDlqToEnd({
      kafka: this.options.kafka,
      topic: this.dlqTopic,
      groupId: `${this.options.groupId}.dlq-reprocess`,
      timeoutMs,
      onMessage: (message) => this.reprocessMessage(message),
    });
  }

  /**
   * Одно сообщение из DLQ: вызывается только обработчик из `x-handler`, с теми же проверками
   * `processed_events`. Повторная ошибка — обратно в DLQ с `x-attempts + 1`.
   */
  async reprocessMessage(message: KafkaMessage): Promise<boolean> {
    const headers = headersToStrings(message.headers);
    const handlerName = headers['x-handler'];
    try {
      const registration = [...this.handlers.values()].flat().find((r) => r.name === handlerName);
      if (!registration) throw new Error(`обработчик ${handlerName} не зарегистрирован`);
      const decoded = this.options.registry.decode(JSON.parse(message.value?.toString() ?? ''));
      if (decoded.status !== 'decoded') throw new Error(`тип ${decoded.envelope.type} не известен`);
      const { envelope } = decoded;
      const meta: MessageMeta = {
        topic: headers['x-original-topic'],
        partition: Number(headers['x-original-partition']),
        offset: headers['x-original-offset'],
      };
      await runWithContext(
        { correlationId: envelope.correlationId, causationId: envelope.eventId },
        () => runWithTraceHeaders(headers, () => registration.handle(envelope, meta)),
      );
      return true;
    } catch (error) {
      const attempts = Number(headers['x-attempts'] ?? '0') + 1;
      await this.options.dlq.send(this.dlqTopic, [
        {
          key: message.key,
          value: message.value,
          headers: { ...headers, 'x-error': describeError(error), 'x-attempts': String(attempts) },
        },
      ]);
      this.options.logger.error(
        { handler: handlerName, attempts, err: error },
        'dlq-reprocess: снова ошибка',
      );
      return false;
    }
  }
}
