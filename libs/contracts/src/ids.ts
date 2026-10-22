/**
 * Идентификаторы — UUID v7 (RFC 9562): 48 бит времени в мс, затем случайные биты.
 * Сортируются по времени создания, поэтому B-tree индекс по `uuid` растёт с конца (SD-01, п. 6.1).
 *
 * Внутри одной миллисекунды 12 бит `rand_a` работают как счётчик (RFC 9562, п. 6.2, метод 1):
 * id, созданные одним процессом, строго возрастают.
 */

const MAX_COUNTER = 0xfff;

let lastMs = 0;
let counter = 0;

export function newId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);

  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    // старт со случайного значения в нижней половине: остаётся запас для инкремента
    counter = ((bytes[6] << 8) | bytes[7]) & 0x7ff;
  } else if (counter < MAX_COUNTER) {
    // та же миллисекунда или часы ушли назад: продолжаем от последнего значения
    counter++;
  } else {
    // счётчик исчерпан: занимаем следующую миллисекунду
    lastMs++;
    counter = 0;
  }

  const high = Math.floor(lastMs / 2 ** 32);
  const low = lastMs % 2 ** 32;
  bytes[0] = (high >>> 8) & 0xff;
  bytes[1] = high & 0xff;
  bytes[2] = (low >>> 24) & 0xff;
  bytes[3] = (low >>> 16) & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;
  bytes[6] = 0x70 | (counter >>> 8); // версия 7
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // вариант RFC 9562

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Время создания UUID v7 в мс. */
export function idTimestamp(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
