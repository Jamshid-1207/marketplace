import { env } from '../../../server/config';

/** Готов, если отвечает gateway: без него кабинет ничего не покажет. */
export async function GET() {
  try {
    const response = await fetch(new URL('/health/ready', env.GATEWAY_URL), {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    return Response.json({ gateway: response.ok }, { status: response.ok ? 200 : 503 });
  } catch {
    return Response.json({ gateway: false }, { status: 503 });
  }
}
