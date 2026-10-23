/**
 * Шаблоны писем (SD-06, п. 6.3). Тексты — по локали; `uz` появится после MVP, ключи — уже сейчас.
 * Данные шаблона сохраняются вместе с письмом при обработке события.
 */
export interface TemplateData {
  'order-confirmed': { orderId: string; totalMinor: number; shops: number };
  'seller-new-sub-order': {
    orderId: string;
    subOrderId: string;
    amountMinor: number;
    items: number;
  };
  'order-cancelled': { orderId: string; reason: string };
  'sub-order-shipped': { orderId: string; subOrderId: string; amountMinor: number };
  'sub-order-delivered': { orderId: string; subOrderId: string; amountMinor: number };
  'sub-order-cancelled': {
    orderId: string;
    subOrderId: string;
    amountMinor: number;
    cancelledBy: string;
  };
  'seller-sub-order-cancelled': {
    orderId: string;
    subOrderId: string;
    amountMinor: number;
    cancelledBy: string;
  };
  refunded: { orderId: string; amountMinor: number };
  'stock-low': { skuId: string; available: number; threshold: number };
  'payout-paid': { payoutId: string; amountMinor: number };
  'seller-registered': { name: string };
  'seller-approved': Record<string, never>;
  'seller-rejected': { reason: string | null };
  'seller-blocked': { reason: string | null };
}

export type Template = keyof TemplateData;
export type Locale = 'ru';

export interface Rendered {
  subject: string;
  text: string;
}

/** Сумма в сумах из тийинов: «2 990 000 сум», «590,50 сум». */
export function sum(minor: number): string {
  const formatted = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(
    minor / 100,
  );
  return `${formatted.replace(/\s/g, ' ')} сум`;
}

/** Номер заказа для человека: хвост UUID (у UUID v7 начало — время, оно у заказов похоже). */
export function number(id: string): string {
  return id.slice(-8).toUpperCase();
}

const CANCEL_REASONS: Record<string, string> = {
  out_of_stock: 'товара нет в наличии',
  payment_failed: 'оплата не прошла',
  payment_timeout: 'заказ не оплачен вовремя',
};
const BY: Record<string, string> = { buyer: 'по вашей просьбе', seller: 'продавцом' };
const BY_SELLER: Record<string, string> = { buyer: 'покупателем', seller: 'вами' };

type Renderers = { [T in Template]: (d: TemplateData[T]) => Rendered };

const ru: Renderers = {
  'order-confirmed': (d) => ({
    subject: `Заказ ${number(d.orderId)} подтверждён`,
    text: `Оплата прошла, заказ ${number(d.orderId)} подтверждён.\nСумма: ${sum(d.totalMinor)}. Магазинов в заказе: ${d.shops}.`,
  }),
  'seller-new-sub-order': (d) => ({
    subject: `Новый заказ ${number(d.subOrderId)}`,
    text: `Покупатель оплатил заказ ${number(d.subOrderId)} на ${sum(d.amountMinor)}, позиций: ${d.items}.\nОтгрузите его в кабинете продавца.`,
  }),
  'order-cancelled': (d) => ({
    subject: `Заказ ${number(d.orderId)} отменён`,
    text: `Заказ ${number(d.orderId)} отменён: ${CANCEL_REASONS[d.reason] ?? d.reason}. Деньги не списаны.`,
  }),
  'sub-order-shipped': (d) => ({
    subject: `Заказ ${number(d.subOrderId)} отправлен`,
    text: `Продавец отправил часть заказа ${number(d.orderId)} на ${sum(d.amountMinor)}.`,
  }),
  'sub-order-delivered': (d) => ({
    subject: `Заказ ${number(d.subOrderId)} доставлен`,
    text: `Часть заказа ${number(d.orderId)} на ${sum(d.amountMinor)} доставлена.`,
  }),
  'sub-order-cancelled': (d) => ({
    subject: `Заказ ${number(d.subOrderId)} отменён`,
    text: `Часть заказа ${number(d.orderId)} на ${sum(d.amountMinor)} отменена ${BY[d.cancelledBy] ?? ''}. Деньги вернутся на карту.`,
  }),
  'seller-sub-order-cancelled': (d) => ({
    subject: `Заказ ${number(d.subOrderId)} отменён`,
    text: `Заказ ${number(d.subOrderId)} на ${sum(d.amountMinor)} отменён ${BY_SELLER[d.cancelledBy] ?? ''}. Резерв товара снят.`,
  }),
  refunded: (d) => ({
    subject: `Возврат по заказу ${number(d.orderId)}`,
    text: `Мы вернули ${sum(d.amountMinor)} по заказу ${number(d.orderId)}.`,
  }),
  'stock-low': (d) => ({
    subject: 'Товар заканчивается',
    text: `Остаток SKU ${d.skuId}: ${d.available} шт. — не больше порога ${d.threshold}. Пополните склад.`,
  }),
  'payout-paid': (d) => ({
    subject: 'Выплата отправлена',
    text: `Выплата ${number(d.payoutId)} на ${sum(d.amountMinor)} отправлена на ваш счёт.`,
  }),
  'seller-registered': (d) => ({
    subject: 'Магазин на модерации',
    text: `Магазин «${d.name}» зарегистрирован и ждёт проверки. Пока можно готовить товары.`,
  }),
  'seller-approved': () => ({
    subject: 'Магазин одобрен',
    text: 'Модерация пройдена: товары магазина можно публиковать.',
  }),
  'seller-rejected': (d) => ({
    subject: 'Магазин не прошёл модерацию',
    text: `Магазин отклонён${d.reason ? `: ${d.reason}` : '.'}`,
  }),
  'seller-blocked': (d) => ({
    subject: 'Магазин заблокирован',
    text: `Магазин заблокирован${d.reason ? `: ${d.reason}` : '.'} Товары сняты с витрины.`,
  }),
};

const LOCALES: Record<Locale, Renderers> = { ru };

export function render<T extends Template>(
  template: T,
  data: TemplateData[T],
  locale: Locale = 'ru',
): Rendered {
  return LOCALES[locale][template](data);
}
