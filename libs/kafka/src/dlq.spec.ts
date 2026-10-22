import { describeError, dlqTopic, headersToStrings } from './dlq';

describe('dlq', () => {
  it('DLQ — на consumer group', () => {
    expect(dlqTopic('crm-service')).toBe('crm-service.dlq');
  });

  it('заголовки Kafka приводятся к строкам; пустые пропускаются, массивы склеиваются', () => {
    expect(
      headersToStrings({
        traceparent: Buffer.from('tp'),
        plain: 'text',
        multi: [Buffer.from('a'), 'b'],
        missing: undefined,
      }),
    ).toEqual({ traceparent: 'tp', plain: 'text', multi: 'a,b' });
    expect(headersToStrings(undefined)).toEqual({});
  });

  it('описание ошибки: стек, иначе строка; длина ограничена', () => {
    expect(describeError(new Error('boom'))).toContain('Error: boom');
    expect(describeError('plain failure')).toBe('plain failure');
    const noStack = Object.assign(new Error('no stack'), { stack: undefined });
    expect(describeError(noStack)).toBe('Error: no stack');
    expect(describeError('x'.repeat(5_000))).toHaveLength(2_000);
  });
});
