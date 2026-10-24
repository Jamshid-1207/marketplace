import { OrderView, SellerNamesResponse } from '@repo/contracts';
import { notFound, redirect } from 'next/navigation';
import { OrderLive } from '../../../features/orders/OrderLive';
import { gateway, GatewayError, optional } from '../../../server/gateway';
import { signedIn } from '../../../server/session';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pay?: string }>;
};

export const metadata = { title: 'Заказ' };

/**
 * Заказ (SD-07, п. 3.3): сюда покупатель приходит с оформления (`?pay=1`) и возвращается со
 * страницы оплаты провайдера. Чужой заказ — `404` (ADR-0006, п. 5).
 */
export default async function OrderPage({ params, searchParams }: Props) {
  const { id } = await params;
  if (!(await signedIn())) redirect(`/login?next=/orders/${encodeURIComponent(id)}`);
  let order: OrderView;
  try {
    order = await gateway(`/orders/${encodeURIComponent(id)}`, { schema: OrderView });
  } catch (error) {
    if (error instanceof GatewayError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  }
  const sellerIds = [...new Set(order.subOrders.map((sub) => sub.sellerId))];
  const names = await optional(
    () =>
      gateway(`/catalog/sellers?ids=${sellerIds.join(',')}`, {
        schema: SellerNamesResponse,
        token: null,
        timeoutMs: 2_000,
      }),
    { items: [] },
  );

  return (
    <OrderLive
      initial={order}
      sellerNames={Object.fromEntries(names.items.map((s) => [s.sellerId, s.name]))}
      pay={(await searchParams).pay === '1'}
    />
  );
}
