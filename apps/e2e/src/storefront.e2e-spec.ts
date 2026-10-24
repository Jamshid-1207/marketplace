import { DEV_CATALOG, DEV_WAREHOUSES, type CartView, type OrderView } from '@repo/contracts';
import { getOrder, login, postOrder, untilPaymentPage, untilStatus } from './support/api';
import { newUser, request, storefront } from './support/catalog';
import { seller } from './support/seller';
import { eventually, PSP_URL, standFetch } from './support/stand';

// чайник и кастрюли — товары магазина B, лежат только на одном его складе
const [phone, , kettle, pots] = DEV_CATALOG;
const warehouseB = DEV_WAREHOUSES.find((w) => w.sellerId === pots.sellerId)?.warehouseId as string;
const shipping = {
  recipientName: 'Покупатель витрины',
  phone: '+998901234567',
  address: 'Ташкент, ул. Тестовая, 7',
};
/** Куда fake-psp возвращает покупателя: страница заказа витрины (compose, `PAYMENT_RETURN_URL`). */
const returnUrl = (orderId: string) => `http://localhost:3001/orders/${orderId}`;

const potsInStock = async () => {
  const page = await storefront.search({ q: pots.title });
  const hit = (page.body.items as { productId: string; inStock?: boolean }[]).find(
    (item) => item.productId === pots.productId,
  );
  const card = await storefront.product(pots.productId);
  const sku = (card.body.skus as { skuId: string; inStock: boolean }[] | undefined)?.find(
    (s) => s.skuId === pots.skuId,
  );
  return { search: hit?.inStock, card: sku?.inStock };
};

const cart = (token: string) => ({
  get: () => request<CartView>(token, 'GET', '/cart'),
  put: (skuId: string, qty: number) =>
    request<CartView>(token, 'PUT', `/cart/lines/${skuId}`, { qty }),
  merge: (lines: { skuId: string; qty: number }[]) =>
    request<{ cart: CartView; skipped: unknown[] }>(token, 'POST', '/cart/merge', { lines }),
});
const quantities = (view: CartView) => Object.fromEntries(view.lines.map((l) => [l.skuId, l.qty]));

/**
 * Этап 7 через gateway (SD-07, п. 1, 9): то, на что опирается витрина, — без браузера.
 * Сценарии в браузере — Playwright (шаг 6).
 */
describe('этап 7: витрина — API', () => {
  let buyer: string;
  let sellerB: ReturnType<typeof seller>;

  beforeAll(async () => {
    const [b, s] = await Promise.all(['buyer-2', 'seller-b'].map(login));
    [buyer, sellerB] = [b, seller(s)];
  });

  it('9, 7. наличие: остаток обнулён — «нет в наличии» и отмена out_of_stock с недостающим SKU; вернули — снова в наличии', async () => {
    await eventually(async () => ((await potsInStock()).search === true ? true : undefined), {
      what: 'кастрюли в наличии до сценария',
    });
    // Кастрюли, а не чайник: чайник есть в подтверждённых, но не отгруженных заказах других
    // сценариев, а такой резерв держится до отгрузки. Резервы кастрюль — только незакреплённые:
    // их снимет TTL, и ждать их нужно, иначе они вернули бы товар посреди сценария
    const { available } = await eventually(
      async () => {
        const stock = await sellerB.stock(pots.skuId);
        return stock.reserved === 0 ? stock : undefined;
      },
      { what: 'резервы кастрюль сняты', timeoutMs: 150_000 },
    );
    expect((await sellerB.adjust(warehouseB, pots.skuId, -available)).status).toBe(201);
    try {
      await eventually(
        async () => {
          const state = await potsInStock();
          return state.search === false && state.card === false ? state : undefined;
        },
        { what: 'кастрюли «нет в наличии» в поиске и карточке' },
      );
      const inStockOnly = await storefront.search({ q: pots.title, inStock: 'true' });
      expect(
        (inStockOnly.body.items as { productId: string }[]).map((i) => i.productId),
      ).not.toContain(pots.productId);

      const order = await postOrder(buyer, {
        body: { lines: [{ skuId: pots.skuId, qty: 1 }], shipping },
      });
      expect(order.status).toBe(202);
      const cancelled = await untilStatus(buyer, order.body.orderId, 'CANCELLED');
      expect(cancelled).toMatchObject({
        cancelReason: 'out_of_stock',
        unavailableSkus: [pots.skuId],
      });
    } finally {
      await sellerB.adjust(warehouseB, pots.skuId, available);
    }
    await eventually(
      async () => {
        const state = await potsInStock();
        return state.search === true && state.card === true ? state : undefined;
      },
      { what: 'кастрюли снова в наличии' },
    );
  });

  it('3, 4. корзина: объединение гостевой, оплата со страницы fake-psp с возвратом в витрину, купленное ушло из корзины', async () => {
    const { tokens } = await newUser('storefront');
    const token = tokens.accessToken;
    const mine = cart(token);
    expect((await mine.put(phone.skuId, 1)).status).toBe(200);
    const merged = await mine.merge([
      { skuId: phone.skuId, qty: 3 },
      { skuId: kettle.skuId, qty: 1 },
    ]);
    expect(merged.status).toBe(200);
    expect(quantities(merged.body.cart)).toEqual({ [phone.skuId]: 3, [kettle.skuId]: 1 });
    expect(quantities((await mine.merge([{ skuId: phone.skuId, qty: 3 }])).body.cart)).toEqual({
      [phone.skuId]: 3,
      [kettle.skuId]: 1,
    });
    // чужая корзина не видна: путь без покупателя, он — из токена
    expect(quantities((await cart(buyer).get()).body)).not.toEqual(quantities(merged.body.cart));

    // витрина оформляет доступные строки корзины; здесь — телефон 1 и чайник 1
    const order = await postOrder(token, {
      body: {
        lines: [
          { skuId: phone.skuId, qty: 1 },
          { skuId: kettle.skuId, qty: 1 },
        ],
        shipping,
      },
    });
    expect(order.status).toBe(202);
    const { orderId } = order.body;
    const pspId = await untilPaymentPage(token, orderId);

    const page = await (await standFetch(`${PSP_URL}/pay/${pspId}`)).text();
    expect(page).toContain(`href="${returnUrl(orderId)}"`);
    const paid = await standFetch(`${PSP_URL}/pay/${pspId}/authorize`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(paid.status).toBe(303);
    expect(paid.headers.get('location')).toBe(returnUrl(orderId));

    const confirmed = (await untilStatus(token, orderId, 'CONFIRMED')) as OrderView;
    expect(confirmed.unavailableSkus).toEqual([]);
    expect(confirmed.subOrders.every((s) => s.refundStatus === null)).toBe(true);
    await eventually(
      async () => {
        const view = (await mine.get()).body;
        return quantities(view)[phone.skuId] === 2 && !(kettle.skuId in quantities(view))
          ? view
          : undefined;
      },
      { what: 'купленное ушло из корзины' },
    );
    expect((await getOrder(token, orderId)).status).toBe(200);
  });
});
