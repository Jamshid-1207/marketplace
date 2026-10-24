import { SkuLookupResponse } from '@repo/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { gateway, GatewayError } from '../../../server/gateway';

/** Данные строк гостевой корзины (SD-07, п. 5.3): что можно заказать и почём. */
export async function GET(request: NextRequest) {
  const ids = request.nextUrl.searchParams.get('ids') ?? '';
  try {
    const skus = await gateway(`/catalog/skus?ids=${encodeURIComponent(ids)}`, {
      schema: SkuLookupResponse,
      token: null,
      timeoutMs: 2_000,
    });
    return NextResponse.json(skus);
  } catch (error) {
    return NextResponse.json({}, { status: error instanceof GatewayError ? error.status : 502 });
  }
}
