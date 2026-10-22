import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Проверка подписи webhook провайдера (SD-02, п. 6.3):
 * `X-PSP-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>`.
 */
export const SIGNATURE_HEADER = 'x-psp-signature';

/** Допуск по времени: старее — повтор перехваченного запроса. */
export const SIGNATURE_TOLERANCE_SEC = 5 * 60;

const FORMAT = /^t=(\d+),v1=([0-9a-f]{64})$/;

export function verifySignature(
  body: string,
  header: string | undefined,
  secret: string,
  nowMs: number,
  toleranceSec = SIGNATURE_TOLERANCE_SEC,
): boolean {
  const match = header ? FORMAT.exec(header) : null;
  if (!match) return false;
  const [, timestamp, signature] = match;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  // сравнение за постоянное время: по нему нельзя подбирать подпись побайтно
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
