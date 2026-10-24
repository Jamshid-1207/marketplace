import { OrderView } from '@repo/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { gateway, GatewayError } from '../../../../server/gateway';

/** Опрос статуса заказа раз в секунду (ADR-0005, п. 9). Токен — из cookie, наружу не уходит. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(
      await gateway(`/orders/${encodeURIComponent(id)}`, { schema: OrderView }),
    );
  } catch (error) {
    return NextResponse.json({}, { status: error instanceof GatewayError ? error.status : 502 });
  }
}
