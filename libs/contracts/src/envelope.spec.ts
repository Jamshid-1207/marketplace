import { createEnvelope, EnvelopeSchema } from './envelope';
import { SmokePingedV1 } from './events/smoke/smoke-pinged.v1';
import { newId } from './ids';

describe('createEnvelope', () => {
  const pingId = newId();
  const aggregate = { aggregateId: pingId, aggregateVersion: 1 };

  it('заполняет eventId, время и метаданные определения', () => {
    const now = new Date('2026-10-22T10:00:00.000Z');
    const envelope = createEnvelope(
      SmokePingedV1,
      { pingId },
      aggregate,
      { correlationId: 'req-1', causationId: null },
      now,
    );

    expect(envelope).toEqual({
      eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      type: 'smoke.pinged',
      version: 1,
      aggregateType: 'smoke',
      aggregateId: pingId,
      aggregateVersion: 1,
      occurredAt: '2026-10-22T10:00:00.000Z',
      correlationId: 'req-1',
      causationId: null,
      payload: { pingId },
    });
    expect(EnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it('переносит correlation и causation из контекста', () => {
    const causationId = newId();
    const envelope = createEnvelope(SmokePingedV1, { pingId }, aggregate, {
      correlationId: 'req-2',
      causationId,
    });
    expect(envelope.correlationId).toBe('req-2');
    expect(envelope.causationId).toBe(causationId);
  });

  it('у каждого конверта свой eventId', () => {
    const ctx = { correlationId: 'req-3', causationId: null };
    const a = createEnvelope(SmokePingedV1, { pingId }, aggregate, ctx);
    const b = createEnvelope(SmokePingedV1, { pingId }, aggregate, ctx);
    expect(a.eventId).not.toBe(b.eventId);
  });

  it('не публикует невалидный payload или агрегат', () => {
    const ctx = { correlationId: 'req-4', causationId: null };
    expect(() => createEnvelope(SmokePingedV1, { pingId: 'not-a-uuid' }, aggregate, ctx)).toThrow();
    expect(() =>
      createEnvelope(SmokePingedV1, { pingId }, { aggregateId: pingId, aggregateVersion: 0 }, ctx),
    ).toThrow();
    expect(() =>
      createEnvelope(SmokePingedV1, { pingId }, aggregate, {
        correlationId: '',
        causationId: null,
      }),
    ).toThrow();
  });
});
