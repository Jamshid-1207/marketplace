'use client';

import { formatSum, OrderView } from '@repo/contracts';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Badge, Button, buttonVariants, Card } from '@repo/ui';
import { cancelSubOrder } from './actions';
import { canCancel, orderNumber, shouldPoll, shouldRedirectToPayment } from './status';

const POLL_MS = 1_000;

interface Props {
  initial: OrderView;
  sellerNames: Record<string, string>;
  /** Покупатель пришёл с оформления: при первом `AWAITING_PAYMENT` — сразу на оплату. */
  pay: boolean;
}

/**
 * Заказ со статусом оформления (SD-07, п. 3.3): опрос раз в секунду, пока вкладка видна и статус
 * не итоговый (ADR-0005, п. 9); переход на оплату; под-заказы, отмена и возврат денег.
 */
export function OrderLive({ initial, sellerNames, pay }: Props) {
  const t = useTranslations('orders');
  const [order, setOrder] = useState(initial);
  const [cancelError, setCancelError] = useState(false);
  const [pending, start] = useTransition();
  const redirected = useRef(false);

  useEffect(() => {
    if (!shouldPoll(order)) return;
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      const response = await fetch(`/bff/orders/${order.orderId}`).catch(() => null);
      if (response?.ok) setOrder(OrderView.parse(await response.json()));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [order]);

  useEffect(() => {
    if (redirected.current || !shouldRedirectToPayment(order, pay)) return;
    redirected.current = true;
    // назад со страницы оплаты — без ?pay=1, иначе витрина снова отправила бы туда же
    window.history.replaceState(null, '', `/orders/${order.orderId}`);
    window.location.assign(order.paymentUrl as string);
  }, [order, pay]);

  function cancel(subOrderId: string) {
    if (!window.confirm(t('cancelConfirm'))) return;
    setCancelError(false);
    start(async () => {
      const ok = await cancelSubOrder(order.orderId, subOrderId);
      if (!ok) return setCancelError(true);
      const response = await fetch(`/bff/orders/${order.orderId}`);
      if (response.ok) setOrder(OrderView.parse(await response.json()));
    });
  }

  const missing = order.subOrders
    .flatMap((sub) => sub.lines)
    .filter((line) => order.unavailableSkus.includes(line.skuId));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">
          {t('order', { number: orderNumber(order.orderId) })}
        </h1>
        <Badge
          data-testid="order-status"
          tone={
            order.status === 'CONFIRMED'
              ? 'success'
              : order.status === 'CANCELLED'
                ? 'danger'
                : 'brand'
          }
        >
          {t(`state.${order.status}`)}
        </Badge>
        <span className="ml-auto text-lg font-semibold tabular-nums">
          {formatSum(order.total.amountMinor)}
        </span>
      </div>

      {order.status === 'AWAITING_PAYMENT' && order.paymentUrl && (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <span className="text-sm text-slate-600">{t('payHint')}</span>
          <a href={order.paymentUrl} className={buttonVariants({ className: 'ml-auto' })}>
            {t('pay')}
          </a>
        </Card>
      )}

      {order.status === 'CANCELLED' && order.cancelReason && (
        <Card className="space-y-2 p-4">
          <p className="font-medium text-red-700">{t(`cancelReason.${order.cancelReason}`)}</p>
          {missing.length > 0 && (
            <p className="text-sm text-slate-600">
              {t('missing', { items: missing.map((line) => line.title).join(', ') })}
            </p>
          )}
          <Link
            href={
              order.unavailableSkus.length
                ? `/cart?missing=${order.unavailableSkus.join(',')}`
                : '/cart'
            }
            className="inline-block text-sm font-medium text-brand-700 hover:underline"
          >
            {t('toCart')}
          </Link>
        </Card>
      )}

      {order.subOrders.map((sub) => (
        <Card key={sub.subOrderId} className="divide-y divide-slate-100" data-testid="sub-order">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <span className="font-medium">
              {sellerNames[sub.sellerId]
                ? t('shop', { name: sellerNames[sub.sellerId] })
                : t('unknownShop')}
            </span>
            <Badge
              tone={
                sub.status === 'CANCELLED'
                  ? 'neutral'
                  : sub.status === 'DELIVERED'
                    ? 'success'
                    : 'brand'
              }
            >
              {t(`subStatus.${sub.status}`)}
            </Badge>
            {sub.refundStatus && <Badge tone="warning">{t(`refund.${sub.refundStatus}`)}</Badge>}
            <span className="ml-auto font-semibold tabular-nums">
              {formatSum(sub.amount.amountMinor)}
            </span>
            {canCancel(sub) && (
              <Button
                size="sm"
                variant="danger"
                disabled={pending}
                onClick={() => cancel(sub.subOrderId)}
              >
                {t('cancel')}
              </Button>
            )}
          </div>
          <ul className="px-4 py-2 text-sm">
            {sub.lines.map((line) => (
              <li key={line.skuId} className="flex justify-between gap-3 py-1">
                <span>
                  {line.title} × {line.qty}
                </span>
                <span className="tabular-nums">
                  {formatSum(line.unitPrice.amountMinor * line.qty)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      {cancelError && (
        <p role="alert" className="text-sm text-red-700">
          {t('cancelFailed')}
        </p>
      )}
    </div>
  );
}
