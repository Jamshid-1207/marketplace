import { SearchResponse } from '@repo/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { gateway, GatewayError } from '../../../server/gateway';

/** Следующая страница поиска для «Показать ещё» (SD-07, п. 3.2). Только GET (решение 3). */
export async function GET(request: NextRequest) {
  try {
    const page = await gateway(`/catalog/search?${request.nextUrl.searchParams}`, {
      schema: SearchResponse,
      token: null,
    });
    return NextResponse.json(page);
  } catch (error) {
    return NextResponse.json({}, { status: error instanceof GatewayError ? error.status : 502 });
  }
}
