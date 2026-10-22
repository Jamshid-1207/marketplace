import { z } from 'zod';
import { createEnvelope } from './envelope';
import {
  ContractError,
  InvalidMessageError,
  MissingUpcasterError,
  RegistryError,
  UnknownMessageVersionError,
} from './errors';
import { newId } from './ids';
import { defineMessage, MessageRegistry } from './registry';

// Тестовое событие в двух версиях: v2 переименовала поле и добавила обязательное
const ThingV1 = defineMessage({
  type: 'thing.happened',
  version: 1,
  kind: 'event',
  topic: 'thing.events',
  aggregateType: 'thing',
  schema: z.object({ thingId: z.uuid(), title: z.string() }),
  key: (p) => p.thingId,
});

const ThingV2 = defineMessage({
  type: 'thing.happened',
  version: 2,
  kind: 'event',
  topic: 'thing.events',
  aggregateType: 'thing',
  schema: z.object({ thingId: z.uuid(), name: z.string(), priority: z.number().int() }),
  key: (p) => p.thingId,
});

const upcastV1 = (payload: unknown) => {
  const { thingId, title } = payload as z.infer<typeof ThingV1.schema>;
  return { thingId, name: title, priority: 0 };
};

const registry = () =>
  new MessageRegistry([ThingV1, ThingV2]).registerUpcaster('thing.happened', 1, upcastV1);

const ctx = { correlationId: 'req-1', causationId: null };

describe('defineMessage', () => {
  const base = {
    version: 1,
    aggregateType: 'x',
    schema: z.object({ id: z.string() }),
    key: (p: { id: string }) => p.id,
  };

  it('проверяет имя по соглашению ADR-0002, п. 5', () => {
    expect(() =>
      defineMessage({ ...base, type: 'Thing.Happened', kind: 'event', topic: 'x.events' }),
    ).toThrow(RegistryError);
    expect(() =>
      defineMessage({ ...base, type: 'reserve-stock', kind: 'command', topic: 'x.commands' }),
    ).toThrow(RegistryError);
    expect(
      defineMessage({ ...base, type: 'ReserveStock', kind: 'command', topic: 'erp.commands' }).type,
    ).toBe('ReserveStock');
  });

  it('запрещает команду в топике событий и событие в топике команд', () => {
    expect(() =>
      defineMessage({ ...base, type: 'ReserveStock', kind: 'command', topic: 'erp.events' }),
    ).toThrow(RegistryError);
    expect(() =>
      defineMessage({ ...base, type: 'stock.reserved', kind: 'event', topic: 'erp.commands' }),
    ).toThrow(RegistryError);
    expect(() =>
      defineMessage({ ...base, type: 'stock.reserved', kind: 'event', topic: 'erp' }),
    ).toThrow(RegistryError);
  });

  it('требует целую версию ≥ 1', () => {
    expect(() =>
      defineMessage({
        ...base,
        version: 0,
        type: 'stock.reserved',
        kind: 'event',
        topic: 'erp.events',
      }),
    ).toThrow(RegistryError);
  });

  it('ключ партиции берётся из payload', () => {
    const thingId = newId();
    expect(ThingV1.key({ thingId, title: 't' })).toBe(thingId);
  });
});

describe('MessageRegistry: регистрация и verify', () => {
  it('не даёт зарегистрировать версию дважды', () => {
    expect(() => new MessageRegistry([ThingV1, ThingV1])).toThrow(RegistryError);
  });

  it('не даёт сменить топик или агрегат между версиями', () => {
    const moved = { ...ThingV2, topic: 'other.events' };
    expect(() => new MessageRegistry([ThingV1, moved])).toThrow(/topic/);
  });

  it('не даёт зарегистрировать upcaster дважды', () => {
    expect(() => registry().registerUpcaster('thing.happened', 1, upcastV1)).toThrow(RegistryError);
  });

  it('verify требует upcaster для каждой старой версии', () => {
    expect(() => new MessageRegistry([ThingV1, ThingV2]).verify()).toThrow(/upcaster/);
    expect(() => registry().verify()).not.toThrow();
  });

  it('verify ловит пропущенную версию', () => {
    expect(() => new MessageRegistry([ThingV2]).verify()).toThrow(/пропущена версия v1/);
  });

  it('verify ловит upcaster без целевой версии', () => {
    const r = new MessageRegistry([ThingV1]).registerUpcaster('thing.happened', 1, upcastV1);
    expect(() => r.verify()).toThrow(/нет версии/);
  });

  it('latest и definitions', () => {
    expect(registry().latest('thing.happened')).toBe(ThingV2);
    expect(registry().latest('nope.nothing')).toBeUndefined();
    expect(registry().definitions()).toEqual([ThingV1, ThingV2]);
  });
});

describe('MessageRegistry.decode', () => {
  const thingId = newId();
  const aggregate = { aggregateId: thingId, aggregateVersion: 1 };
  // через JSON — как сообщение приходит из Kafka
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

  it('отдаёт последнюю версию без изменений', () => {
    const envelope = createEnvelope(ThingV2, { thingId, name: 'n', priority: 3 }, aggregate, ctx);
    const result = registry().decode(wire(envelope));
    expect(result).toEqual({ status: 'decoded', definition: ThingV2, envelope });
  });

  it('приводит старую версию к последней через upcaster', () => {
    const envelope = createEnvelope(ThingV1, { thingId, title: 'old' }, aggregate, ctx);
    const result = registry().decode(wire(envelope));
    expect(result.status).toBe('decoded');
    if (result.status !== 'decoded') return;
    expect(result.definition).toBe(ThingV2);
    expect(result.envelope.version).toBe(2);
    expect(result.envelope.payload).toEqual({ thingId, name: 'old', priority: 0 });
    expect(result.envelope.eventId).toBe(envelope.eventId);
  });

  it('пропускает неизвестный тип: это сообщение другого потребителя', () => {
    const envelope = createEnvelope(ThingV1, { thingId, title: 't' }, aggregate, ctx);
    const result = new MessageRegistry().decode(wire(envelope));
    expect(result.status).toBe('unknown-type');
  });

  it('невалидный конверт — ContractError', () => {
    expect(() => registry().decode({ type: 'thing.happened' })).toThrow(InvalidMessageError);
    expect(() => registry().decode('not json object')).toThrow(ContractError);
  });

  it('проверяет payload схемой его версии до upcast', () => {
    const envelope = createEnvelope(ThingV1, { thingId, title: 't' }, aggregate, ctx);
    const broken = { ...wire(envelope), payload: { thingId, title: 42 } };
    const upcaster = jest.fn(upcastV1);
    const r = new MessageRegistry([ThingV1, ThingV2]).registerUpcaster(
      'thing.happened',
      1,
      upcaster,
    );
    expect(() => r.decode(broken)).toThrow(InvalidMessageError);
    expect(upcaster).not.toHaveBeenCalled();
  });

  it('проверяет результат upcaster схемой последней версии', () => {
    const envelope = createEnvelope(ThingV1, { thingId, title: 't' }, aggregate, ctx);
    const r = new MessageRegistry([ThingV1, ThingV2]).registerUpcaster(
      'thing.happened',
      1,
      (p) => p,
    );
    expect(() => r.decode(wire(envelope))).toThrow(InvalidMessageError);
  });

  it('неизвестная версия известного типа — ContractError', () => {
    const envelope = createEnvelope(ThingV2, { thingId, name: 'n', priority: 1 }, aggregate, ctx);
    expect(() => new MessageRegistry([ThingV1]).decode(wire(envelope))).toThrow(
      UnknownMessageVersionError,
    );
  });

  it('нет upcaster’а — ContractError', () => {
    const envelope = createEnvelope(ThingV1, { thingId, title: 't' }, aggregate, ctx);
    expect(() => new MessageRegistry([ThingV1, ThingV2]).decode(wire(envelope))).toThrow(
      MissingUpcasterError,
    );
  });
});
