import { SmokePingedV1 } from './events/smoke/smoke-pinged.v1';
import { MessageRegistry } from './registry';

/**
 * Все сообщения системы. Новая версия добавляется сюда вместе с upcaster'ом предыдущей,
 * а контракт-тест требует JSON-фикстуру на каждую версию (ADR-0003, п. 5).
 */
export const messages = new MessageRegistry([SmokePingedV1]);
