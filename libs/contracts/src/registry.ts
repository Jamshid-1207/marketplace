import { z } from 'zod';
import { EnvelopeSchema, type Envelope } from './envelope';
import {
  InvalidMessageError,
  MissingUpcasterError,
  RegistryError,
  UnknownMessageVersionError,
} from './errors';

export type MessageKind = 'event' | 'command';

/**
 * Определение сообщения: тип → схема → топик → ключ партиции (SD-01, п. 6.1).
 * Ключ берётся из payload, поэтому его нельзя выбрать «на глаз» в месте публикации (ADR-0002, п. 4).
 */
export interface MessageDefinition<
  TType extends string = string,
  TVersion extends number = number,
  TSchema extends z.ZodType = z.ZodType,
> {
  readonly type: TType;
  readonly version: TVersion;
  readonly kind: MessageKind;
  readonly topic: string;
  readonly aggregateType: string;
  readonly schema: TSchema;
  readonly key: (payload: z.output<TSchema>) => string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMessageDefinition = MessageDefinition<string, number, any>;

export type PayloadOf<D> =
  D extends MessageDefinition<string, number, infer S> ? z.output<S> : never;

export type Upcaster = (payload: unknown) => unknown;

// событие — сущность.действие в прошедшем времени; команда — PascalCase (ADR-0002, п. 5)
const EVENT_TYPE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const COMMAND_TYPE = /^[A-Z][A-Za-z0-9]*$/;
const TOPIC = /^[a-z][a-z0-9-]*\.(events|commands)$/;

export function defineMessage<
  TType extends string,
  TVersion extends number,
  TSchema extends z.ZodType,
>(
  definition: MessageDefinition<TType, TVersion, TSchema>,
): MessageDefinition<TType, TVersion, TSchema> {
  const { type, version, kind, topic } = definition;
  const typePattern = kind === 'event' ? EVENT_TYPE : COMMAND_TYPE;
  if (!typePattern.test(type)) {
    throw new RegistryError(`${type}: имя не соответствует соглашению для ${kind}`);
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new RegistryError(`${type}: версия должна быть целой и ≥ 1`);
  }
  // команда в топике событий или событие в топике команд — правило code review ADR-0002
  const match = TOPIC.exec(topic);
  if (!match || match[1] !== `${kind}s`) {
    throw new RegistryError(`${type}: ${kind} не может публиковаться в топик ${topic}`);
  }
  return Object.freeze({ ...definition });
}

export type DecodeResult =
  | { status: 'decoded'; definition: AnyMessageDefinition; envelope: Envelope }
  // тип не известен этому сервису: в топике контекста лежат и чужие сообщения (SD-01, п. 6.5)
  | { status: 'unknown-type'; envelope: Envelope };

const versionKey = (type: string, version: number) => `${type}@v${version}`;

export class MessageRegistry {
  private readonly byType = new Map<string, Map<number, AnyMessageDefinition>>();
  private readonly upcasters = new Map<string, Upcaster>();

  constructor(definitions: readonly AnyMessageDefinition[] = []) {
    definitions.forEach((definition) => this.register(definition));
  }

  register(definition: AnyMessageDefinition): this {
    const versions = this.byType.get(definition.type) ?? new Map<number, AnyMessageDefinition>();
    if (versions.has(definition.version)) {
      throw new RegistryError(
        `${versionKey(definition.type, definition.version)} уже зарегистрирован`,
      );
    }
    // смена топика или агрегата между версиями ломает порядок событий агрегата
    for (const other of versions.values()) {
      for (const field of ['kind', 'topic', 'aggregateType'] as const) {
        if (other[field] !== definition[field]) {
          throw new RegistryError(
            `${definition.type}: ${field} v${definition.version} (${definition[field]}) ` +
              `отличается от v${other.version} (${other[field]})`,
          );
        }
      }
    }
    versions.set(definition.version, definition);
    this.byType.set(definition.type, versions);
    return this;
  }

  /** Upcaster приводит payload версии `fromVersion` к `fromVersion + 1` (ADR-0003, п. 5). */
  registerUpcaster(type: string, fromVersion: number, upcaster: Upcaster): this {
    const key = versionKey(type, fromVersion);
    if (this.upcasters.has(key)) {
      throw new RegistryError(`upcaster ${key} уже зарегистрирован`);
    }
    this.upcasters.set(key, upcaster);
    return this;
  }

  definitions(): AnyMessageDefinition[] {
    return [...this.byType.values()].flatMap((versions) => [...versions.values()]);
  }

  latest(type: string): AnyMessageDefinition | undefined {
    const versions = this.byType.get(type);
    if (!versions) return undefined;
    return versions.get(Math.max(...versions.keys()));
  }

  /** Проверка целостности: версии без пропусков, у каждой старой версии есть upcaster, лишних нет. */
  verify(): void {
    for (const [type, versions] of this.byType) {
      const latest = Math.max(...versions.keys());
      for (let version = 1; version <= latest; version++) {
        if (!versions.has(version)) {
          throw new RegistryError(`${type}: пропущена версия v${version}`);
        }
        if (version < latest && !this.upcasters.has(versionKey(type, version))) {
          throw new RegistryError(`${type}: нет upcaster'а v${version} → v${version + 1}`);
        }
      }
    }
    for (const key of this.upcasters.keys()) {
      const [type, version] = key.split('@v');
      const versions = this.byType.get(type);
      if (!versions?.has(Number(version) + 1)) {
        throw new RegistryError(`upcaster ${key}: нет версии, к которой он приводит`);
      }
    }
  }

  /**
   * Разбор входящего сообщения (SD-01, п. 6.5): конверт → схема его версии → upcast → схема
   * последней версии. Нарушение контракта — `ContractError`, его не исправит повтор.
   */
  decode(raw: unknown): DecodeResult {
    const parsed = EnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InvalidMessageError(`невалидный конверт: ${z.prettifyError(parsed.error)}`, {
        cause: parsed.error,
      });
    }
    const envelope = parsed.data as Envelope;

    const versions = this.byType.get(envelope.type);
    if (!versions) return { status: 'unknown-type', envelope };

    const own = versions.get(envelope.version);
    if (!own) {
      throw new UnknownMessageVersionError(
        `${versionKey(envelope.type, envelope.version)} не зарегистрирован`,
      );
    }
    // upcaster получает только проверенные данные своей версии
    let payload = this.parsePayload(own, envelope);

    const latest = this.latest(envelope.type) as AnyMessageDefinition;
    for (let version = envelope.version; version < latest.version; version++) {
      const upcaster = this.upcasters.get(versionKey(envelope.type, version));
      if (!upcaster) {
        throw new MissingUpcasterError(`нет upcaster'а ${versionKey(envelope.type, version)}`);
      }
      payload = upcaster(payload);
    }
    if (latest !== own) {
      payload = this.parsePayload(latest, { ...envelope, payload });
    }

    return {
      status: 'decoded',
      definition: latest,
      envelope: { ...envelope, version: latest.version, payload },
    };
  }

  private parsePayload(definition: AnyMessageDefinition, envelope: Envelope): unknown {
    const result = definition.schema.safeParse(envelope.payload);
    if (!result.success) {
      throw new InvalidMessageError(
        `${versionKey(definition.type, definition.version)}, eventId ${envelope.eventId}: ` +
          z.prettifyError(result.error),
        { cause: result.error },
      );
    }
    return result.data;
  }
}
