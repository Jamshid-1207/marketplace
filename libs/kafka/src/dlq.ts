import type { IHeaders, KafkaMessage, Message } from 'kafkajs';

/** DLQ на consumer group, а не на топик: иначе сообщение заново получили бы все группы (ADR-0002, п. 8). */
export const dlqTopic = (groupId: string) => `${groupId}.dlq`;

/** Обработчик неизвестен: сообщение не удалось даже разобрать. */
export const ANY_HANDLER = '*';

const MAX_ERROR_LENGTH = 2_000;

export interface DlqSource {
  topic: string;
  partition: number;
  groupId: string;
}

export function headersToStrings(headers: IHeaders | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.map(String).join(',') : value.toString();
  }
  return result;
}

export function describeError(error: unknown): string {
  const text =
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Сообщение для DLQ: исходные ключ, значение и заголовки (в том числе `traceparent`) плюс
 * откуда оно, какой обработчик упал, с какой ошибкой и после скольких попыток.
 */
export function toDlqMessage(
  message: KafkaMessage,
  source: DlqSource,
  handler: string,
  error: unknown,
  attempts: number,
): Message {
  return {
    key: message.key,
    value: message.value,
    headers: {
      ...headersToStrings(message.headers),
      'x-original-topic': source.topic,
      'x-original-partition': String(source.partition),
      'x-original-offset': message.offset,
      'x-consumer-group': source.groupId,
      'x-handler': handler,
      'x-error': describeError(error),
      'x-attempts': String(attempts),
    },
  };
}
