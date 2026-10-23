import { eventually, standFetch } from './stand';

/** Почта стенда — Mailpit (ТЗ, 3.7): его API читает письма, которые отправил notification. */
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';

export interface Mail {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Snippet: string;
}

/** Письма адресату, новые сверху. */
export async function mailsTo(email: string): Promise<Mail[]> {
  const query = encodeURIComponent(`to:"${email}"`);
  const res = await standFetch(`${MAILPIT_URL}/api/v1/search?query=${query}&limit=200`);
  if (!res.ok) throw new Error(`Mailpit: ${res.status}`);
  return ((await res.json()) as { messages: Mail[] }).messages;
}

/** Дождаться письма адресату с темой по образцу. */
export function untilMail(email: string, subject: RegExp, timeoutMs = 60_000): Promise<Mail> {
  return eventually(async () => (await mailsTo(email)).find((m) => subject.test(m.Subject)), {
    what: `письмо ${email}: ${subject}`,
    timeoutMs,
    intervalMs: 1_000,
  });
}
