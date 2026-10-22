import { createHmac } from 'node:crypto';

/**
 * Подпись webhook (SD-02, п. 3.2): `X-PSP-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>`.
 * Время входит в подпись: перехваченный webhook нельзя повторить через сутки.
 */
export const SIGNATURE_HEADER = 'x-psp-signature';

export function sign(body: string, secret: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}
