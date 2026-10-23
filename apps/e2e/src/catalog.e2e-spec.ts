import { DEV_CATALOG, DEV_CATEGORIES } from '@repo/contracts';
import { randomUUID } from 'node:crypto';
import { login, postOrder, psp, untilPaymentPage, untilStatus } from './support/api';
import {
  auth,
  claims,
  ids,
  moderation,
  newUser,
  products,
  refreshUntil,
  request,
  storefront,
  type Tokens,
} from './support/catalog';
import { seller } from './support/seller';
import { eventually } from './support/stand';

const [phone] = DEV_CATALOG; // товар магазина A
const shipping = {
  recipientName: 'Покупатель E2E',
  phone: '+998901234567',
  address: 'Ташкент, ул. Тестовая, 1',
};
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('ожидаемого объекта нет');
  return value;
};

/**
 * Критерий готовности этапа 5 (SD-05, п. 1) через gateway на compose-стенде. Сценарии работают
 * с новым магазином C, чтобы не трогать демо-магазины других сценариев; блокировка магазина C
 * (сценарий 5) — последней. Сценарий 10 — остальные файлы e2e со входом через auth.
 */
describe('этап 5: продавцы и каталог', () => {
  let buyer: string;
  let admin: ReturnType<typeof moderation>;
  let sellerB: string;
  let managerA: string;

  // магазин C: владелец — новый пользователь
  const tag = randomUUID().slice(-6); // метка товаров сценария для поиска
  let owner: Tokens;
  let shopId = '';
  let uzbekProduct = { productId: '', skuId: '' };
  let russianProduct = { productId: '', skuId: '' };
  let warehouseId = '';
  let subOrderId = '';

  beforeAll(async () => {
    const [b, adm, sb, m] = await Promise.all(
      ['buyer-1', 'admin', 'seller-b', 'manager-a'].map(login),
    );
    [buyer, admin, sellerB, managerA] = [b, moderation(adm), sb, m];
  });

  /** Черновик с одним SKU, отправленный на модерацию. */
  async function submitted(token: string, title: string, priceMinor: number, description = '') {
    const cabinet = products(token);
    const created = await cabinet.create({
      title,
      description,
      categoryId: DEV_CATEGORIES.kitchen,
    });
    expect(created.status).toBe(201);
    const { productId } = created.body;
    const withSku = await cabinet.addSku(productId, {
      skuCode: `C-${productId.slice(-8)}`,
      priceMinor,
    });
    expect(withSku.status).toBe(201);
    expect((await cabinet.submit(productId)).body.status).toBe('on_review');
    return { productId, skuId: withSku.body.skus[0].skuId };
  }

  const order = (skuId: string) =>
    postOrder(buyer, { body: { lines: [{ skuId, qty: 1 }], shipping } });

  it('1. регистрация, вход, refresh ротируется; повтор старого refresh отзывает семейство', async () => {
    const { email, tokens: first } = await newUser('buyer');
    expect(claims(first.accessToken).roles).toEqual(['buyer']);
    expect((await auth.me(first.accessToken)).body).toMatchObject({ email, seller: null });
    expect((await auth.login(email, 'wrong-password')).status).toBe(401);
    expect((await auth.login(`nobody-${randomUUID()}@e2e.test`, 'x')).status).toBe(401);

    const second = await auth.refresh(first.refreshToken);
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);

    expect((await auth.refresh(first.refreshToken)).status).toBe(401); // повтор
    expect((await auth.refresh(second.body.refreshToken)).status).toBe(401); // семейство отозвано
  });

  it('2. пользователь регистрирует магазин: pending, роль seller после refresh, опубликовать нельзя', async () => {
    ({ tokens: owner } = await newUser('owner'));
    const shop = await request<{ sellerId: string; status: string }>(
      owner.accessToken,
      'POST',
      '/sellers',
      { name: `Магазин C ${tag}` },
    );
    expect(shop.status).toBe(201);
    expect(shop.body.status).toBe('pending');
    shopId = shop.body.sellerId;
    expect((await request(owner.accessToken, 'GET', '/seller/shop')).status).toBe(403);

    owner = await refreshUntil(owner, (c) => c.sellerId === shopId, 'роль в магазине C');
    expect(claims(owner.accessToken).roles).toContain('seller');
    expect((await request(owner.accessToken, 'GET', '/seller/shop')).body).toMatchObject({
      sellerId: shopId,
      status: 'pending',
    });

    uzbekProduct = await submitted(
      owner.accessToken,
      `Elektr choynak ${tag}`,
      150_000_00,
      'Oʻzbekistonda ishlab chiqarilgan',
    );
    expect((await admin.approve(uzbekProduct.productId)).status).toBe(409);
  });

  it('3. магазин одобрен, товар одобрен: read-модели order и erp, заказ до CONFIRMED', async () => {
    expect(shopId).not.toBe('');
    expect((await admin.seller(shopId, 'approve')).status).toBe(200);
    const approved = await admin.approve(uzbekProduct.productId);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('published');
    russianProduct = await submitted(owner.accessToken, `Чайник электрический ${tag}`, 90_000_00);
    expect((await admin.approve(russianProduct.productId)).status).toBe(200);

    // erp узнаёт SKU из product.published: до этого остаток не принять
    const cabinet = seller(owner.accessToken);
    const warehouse = await request<{ warehouseId: string }>(
      owner.accessToken,
      'POST',
      '/seller/warehouses',
      { name: 'Склад C', priority: 1 },
    );
    expect(warehouse.status).toBe(201);
    warehouseId = warehouse.body.warehouseId;
    await eventually(
      async () => (await cabinet.adjust(warehouseId, uzbekProduct.skuId, 10)).status === 201,
      { what: 'SKU магазина C в erp' },
    );

    // order узнаёт SKU из product.published: до этого заказ — 422
    const placed = await eventually(
      async () => {
        const res = await order(uzbekProduct.skuId);
        return res.status === 202 ? res.body : undefined;
      },
      { what: 'SKU магазина C в order' },
    );
    await psp.act(await untilPaymentPage(buyer, placed.orderId), 'authorize');
    const confirmed = await untilStatus(buyer, placed.orderId, 'CONFIRMED');
    expect(confirmed.total.amountMinor).toBe(150_000_00);
    subOrderId = must(confirmed.subOrders.find((s) => s.sellerId === shopId)).subOrderId;
  });

  it('4. отклонённый товар: нет в поиске и на витрине, заказ — 422', async () => {
    const rejectedTag = randomUUID().slice(-6);
    const rejected = await submitted(owner.accessToken, `Утюг ${rejectedTag}`, 50_000_00);
    const res = await admin.reject(rejected.productId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(ids((await storefront.search({ q: rejectedTag })).body)).toEqual([]);
    expect((await storefront.product(rejected.productId)).status).toBe(404);
    expect((await order(rejected.skuId)).status).toBe(422);
  });

  it('6. поиск: по-русски, по-узбекски латиницей и кириллицей, фильтры, курсор', async () => {
    const found = async (q: string, extra: Record<string, string | number> = {}) => {
      const res = await storefront.search({ q, ...extra });
      expect(res.status).toBe(200);
      return ids(res.body);
    };
    const { productId: uz } = uzbekProduct;
    const { productId: ru } = russianProduct;
    expect(await found(`чайники ${tag}`)).toEqual([ru]); // стемминг
    expect(await found(`choynak ${tag}`)).toEqual([uz]);
    expect(await found(`Чойнак ${tag}`)).toEqual([uz]); // кириллица → латиница
    expect(await found(`choyn ${tag}`)).toEqual([uz]); // префикс
    expect((await found(tag, { categoryId: DEV_CATEGORIES.home })).sort()).toEqual([uz, ru].sort()); // поддерево
    expect(await found(tag, { categoryId: DEV_CATEGORIES.electronics })).toEqual([]);
    expect(await found(tag, { minPrice: 100_000_00 })).toEqual([uz]);
    expect(await found(tag, { maxPrice: 100_000_00 })).toEqual([ru]);

    const first = (await storefront.search({ q: tag, limit: 1 })).body;
    expect(first.items).toHaveLength(1);
    const second = (
      await storefront.search({ q: tag, limit: 1, cursor: must(first.nextCursor ?? undefined) })
    ).body;
    expect(second.items).toHaveLength(1);
    expect([...ids(first), ...ids(second)].sort()).toEqual([uz, ru].sort());
    const last = second.nextCursor
      ? (await storefront.search({ q: tag, limit: 1, cursor: second.nextCursor })).body.items
      : [];
    expect(last).toEqual([]);
  });

  it('7. сотрудник с правом catalog: после refresh правит товары, склады — 403', async () => {
    const staff = await newUser('staff');
    const hired = await request(owner.accessToken, 'POST', '/seller/staff', {
      email: staff.email,
      scopes: ['catalog'],
    });
    expect(hired.status).toBe(201);
    expect((await request(staff.tokens.accessToken, 'GET', '/seller/products')).status).toBe(403);

    const tokens = await refreshUntil(
      staff.tokens,
      (c) => c.sellerId === shopId,
      'права сотрудника',
    );
    expect(claims(tokens.accessToken)).toMatchObject({ sellerId: shopId, scopes: ['catalog'] });
    const cabinet = products(tokens.accessToken);
    const draft = await cabinet.create({
      title: `Термос ${tag}`,
      categoryId: DEV_CATEGORIES.kitchen,
    });
    expect(draft.status).toBe(201);
    expect(
      (await cabinet.update(draft.body.productId, { title: `Термос 1 л ${tag}` })).status,
    ).toBe(200);
    // цена опубликованного товара — сразу, без модерации
    const repriced = await cabinet.updateSku(russianProduct.productId, russianProduct.skuId, {
      priceMinor: 95_000_00,
    });
    expect(repriced.status).toBe(200);
    expect(repriced.body.status).toBe('published');
    expect((await request(tokens.accessToken, 'GET', '/seller/warehouses')).status).toBe(403);
    expect((await request(tokens.accessToken, 'GET', '/seller/staff')).status).toBe(403);
  });

  it('8. изоляция: чужие товары, SKU, склады, заказы — 404; кабинет без права — 403', async () => {
    const asB = products(sellerB);
    expect((await asB.get(phone.productId)).status).toBe(404);
    expect((await asB.update(phone.productId, { title: 'моё' })).status).toBe(404);
    expect((await asB.updateSku(phone.productId, phone.skuId, { priceMinor: 1 })).status).toBe(404);
    expect((await asB.get(uzbekProduct.productId)).status).toBe(404);
    expect((await asB.submit(uzbekProduct.productId)).status).toBe(404);
    expect((await seller(sellerB).patchWarehouse(warehouseId, { name: 'моё' })).status).toBe(404);
    expect((await seller(sellerB).subOrder(subOrderId)).status).toBe(404);
    expect((await seller(sellerB).adjust(warehouseId, uzbekProduct.skuId, 1)).status).toBe(404);

    // manager-a — только право orders
    const id = phone.productId;
    const sku = `${id}/skus/${phone.skuId}`;
    const cabinet: [string, string][] = [
      ['GET', '/seller/shop'],
      ['GET', '/seller/products'],
      ['POST', '/seller/products'],
      ['GET', `/seller/products/${id}`],
      ['PATCH', `/seller/products/${id}`],
      ['POST', `/seller/products/${id}/skus`],
      ['PATCH', `/seller/products/${sku}`],
      ['DELETE', `/seller/products/${sku}`],
      ['POST', `/seller/products/${id}/submit`],
      ['POST', `/seller/products/${id}/archive`],
      ['GET', '/seller/staff'],
      ['POST', '/seller/staff'],
      ['PUT', `/seller/staff/${randomUUID()}`],
      ['DELETE', `/seller/staff/${randomUUID()}`],
    ];
    for (const [method, path] of cabinet) {
      const res = await request(managerA, method, path, method === 'GET' ? undefined : {});
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 403`);
    }
  });

  it('9. админ создаёт категорию: category.created доходит до payment, ставку можно задать', async () => {
    const created = await admin.category(`Посуда ${tag}`, DEV_CATEGORIES.home);
    expect(created.status).toBe(201);
    const { categoryId } = created.body;
    const set = await eventually(
      async () => {
        const res = await admin.setRate(categoryId, 700);
        return res.status === 200 ? res : undefined;
      },
      { what: 'категория в payment' },
    );
    expect(set.body).toEqual({ categoryId, rateBp: 700 });
  });

  // последним: блокировка закрывает магазин C для остальных сценариев
  it('5. админ блокирует магазин: товары сняты, заказ — 422, права кабинета уходят', async () => {
    expect((await admin.seller(shopId, 'block')).status).toBe(200);
    expect(await ids((await storefront.search({ q: tag })).body)).toEqual([]);
    expect((await storefront.product(uzbekProduct.productId)).status).toBe(404);
    await eventually(async () => (await order(uzbekProduct.skuId)).status === 422, {
      what: 'product.unpublished в order',
    });
    // старый access-токен ещё с правами, но catalog знает о блокировке сразу
    expect(
      (
        await products(owner.accessToken).create({
          title: 'x1',
          categoryId: DEV_CATEGORIES.kitchen,
        })
      ).status,
    ).toBe(403);

    owner = await refreshUntil(owner, (c) => c.sellerId === undefined, 'права магазина C сняты');
    expect(claims(owner.accessToken).roles).toEqual(['buyer']);
    expect((await request(owner.accessToken, 'GET', '/seller/products')).status).toBe(403);
  });
});
