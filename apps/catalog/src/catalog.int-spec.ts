import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DevTokenIssuer, sellerEndpoints, type Claims } from '@repo/auth';
import { DEV_CATALOG, newId } from '@repo/contracts';
import { createTopics, testBrokers, testDatabaseUrl } from '@repo/testing';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import type { PrismaClient } from './generated/prisma/client';
import { PrismaService } from './infrastructure/prisma.service';
import { seedCatalog } from './infrastructure/seed-catalog';

/** catalog через HTTP и Postgres (SD-05, п. 8). Каждый тест заводит свой магазин и товары. */
describe('catalog: продавцы, товары, поиск (интеграция)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let issuer: DevTokenIssuer;
  let jwks: Server;
  let admin: string;

  beforeAll(async () => {
    issuer = await DevTokenIssuer.create();
    // JWKS, как его отдаёт auth (SD-05, п. 5.2)
    jwks = createServer((_, res) => res.end(JSON.stringify(issuer.jwks())));
    await new Promise<void>((resolve) => jwks.listen(0, resolve));
    await createTopics({ topic: 'catalog.events' }, { topic: 'catalog-service.dlq' });
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      KAFKA_BROKERS: testBrokers().join(','),
      KAFKA_FROM_BEGINNING: 'true',
      JWKS_URL: `http://localhost:${(jwks.address() as AddressInfo).port}/.well-known/jwks.json`,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config)],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    admin = await issuer.issue({ sub: newId(), roles: ['buyer', 'admin'], scopes: [] });
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => jwks?.close(resolve));
  });

  const api = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => api().get(url).auth(token, { type: 'bearer' }),
    post: (url: string, body: object = {}) =>
      api().post(url).auth(token, { type: 'bearer' }).send(body),
    patch: (url: string, body: object) =>
      api().patch(url).auth(token, { type: 'bearer' }).send(body),
  });
  const token = (claims: Claims) => issuer.issue(claims);

  /** Корень и подкатегория, уникальные для теста. */
  async function categories() {
    const root = await as(admin).post('/admin/categories', { name: `Корень ${newId()}` });
    const child = await as(admin).post('/admin/categories', {
      name: 'Чайники',
      parentId: root.body.categoryId,
    });
    expect([root.status, child.status]).toEqual([201, 201]);
    return { root: root.body.categoryId as string, child: child.body.categoryId as string };
  }

  /** Магазин, одобренный админом, и токен владельца, как его выпустит auth после обновления. */
  async function shop(approve = true) {
    const owner = newId();
    const buyer = await token({ sub: owner, roles: ['buyer'], scopes: [] });
    const res = await as(buyer).post('/sellers', { name: `Магазин ${owner.slice(-4)}` });
    expect(res.status).toBe(201);
    const sellerId = res.body.sellerId as string;
    if (approve) {
      expect((await as(admin).post(`/admin/sellers/${sellerId}/approve`)).status).toBe(200);
    }
    const seller = await token({
      sub: owner,
      roles: ['buyer', 'seller'],
      sellerId,
      scopes: ['catalog', 'warehouse', 'orders', 'support', 'finance', 'staff'],
    });
    return { sellerId, seller, owner };
  }

  /** Товар с SKU: создан, отправлен на модерацию, одобрен админом. */
  async function product(
    seller: string,
    input: { title: string; description?: string; categoryId: string; prices?: number[] },
  ) {
    const created = await as(seller).post('/seller/products', {
      title: input.title,
      description: input.description ?? '',
      categoryId: input.categoryId,
    });
    expect(created.status).toBe(201);
    const productId = created.body.productId as string;
    for (const [i, priceMinor] of (input.prices ?? [100_00]).entries()) {
      const sku = await as(seller).post(`/seller/products/${productId}/skus`, {
        skuCode: `SKU-${productId.slice(-8)}-${i}`,
        priceMinor,
      });
      expect(sku.status).toBe(201);
    }
    expect((await as(seller).post(`/seller/products/${productId}/submit`)).status).toBe(200);
    const approved = await as(admin).post(`/admin/products/${productId}/approve`);
    expect(approved.status).toBe(200);
    return approved.body as { productId: string; skus: { skuId: string }[] };
  }

  const search = async (query: Record<string, string | number>) => {
    const res = await api().get('/catalog/search').query(query);
    expect(res.status).toBe(200);
    return res.body as {
      items: { productId: string; minPriceMinor: number }[];
      nextCursor: string | null;
    };
  };
  const ids = (body: { items: { productId: string }[] }) => body.items.map((i) => i.productId);

  const outboxTypes = async (key: string) =>
    (await prisma.outbox.findMany({ where: { messageKey: key }, orderBy: { id: 'asc' } })).map(
      (r) => (r.payload as { type: string }).type,
    );

  it('магазин pending: товар не опубликовать (409); после одобрения — product.published', async () => {
    const { child } = await categories();
    const { sellerId, seller } = await shop(false);
    const draft = await as(seller).post('/seller/products', { title: 'Чайник', categoryId: child });
    const productId = draft.body.productId as string;
    await as(seller).post(`/seller/products/${productId}/skus`, { skuCode: 'P-1', priceMinor: 1 });
    await as(seller).post(`/seller/products/${productId}/submit`);
    expect((await as(admin).post(`/admin/products/${productId}/approve`)).status).toBe(409);
    await as(admin).post(`/admin/sellers/${sellerId}/approve`);
    expect((await as(admin).post(`/admin/products/${productId}/approve`)).status).toBe(200);
    expect(await outboxTypes(productId)).toEqual(['product.published']);
    expect(await outboxTypes(sellerId)).toEqual(['seller.registered', 'seller.approved']);
  });

  it('поиск: по-русски со стеммингом, по-узбекски латиницей и кириллицей', async () => {
    const { root } = await categories();
    const { seller } = await shop();
    const tag = newId().slice(-6);
    const kettle = await product(seller, {
      title: `Чайник электрический ${tag}`,
      categoryId: root,
    });
    const uzbek = await product(seller, {
      title: `Elektr choynak ${tag}`,
      description: 'Oʻzbekistonda ishlab chiqarilgan',
      categoryId: root,
    });
    expect(ids(await search({ q: `чайники ${tag}` }))).toEqual([kettle.productId]);
    expect(ids(await search({ q: `choynak ${tag}` }))).toEqual([uzbek.productId]);
    expect(ids(await search({ q: `Чойнак ${tag}` }))).toEqual([uzbek.productId]);
    expect(ids(await search({ q: `ўзбекистон ${tag}` }))).toEqual([uzbek.productId]);
    expect(ids(await search({ q: `choyn ${tag}` }))).toEqual([uzbek.productId]); // префикс
  });

  it('фильтры: категория с поддеревом, цена по активным SKU', async () => {
    const { root, child } = await categories();
    const { seller } = await shop();
    const tag = newId().slice(-6);
    const cheap = await product(seller, {
      title: `Кружка ${tag}`,
      categoryId: child,
      prices: [50_00],
    });
    const pricey = await product(seller, {
      title: `Кружка ${tag} фарфор`,
      categoryId: root,
      prices: [500_00, 900_00],
    });
    expect(ids(await search({ q: tag, categoryId: root })).sort()).toEqual(
      [cheap.productId, pricey.productId].sort(),
    );
    expect(ids(await search({ q: tag, categoryId: child }))).toEqual([cheap.productId]);
    const ranged = await search({ q: tag, minPrice: 100_00, maxPrice: 600_00 });
    expect(ranged.items).toEqual([
      expect.objectContaining({ productId: pricey.productId, minPriceMinor: 500_00 }),
    ]);
  });

  it('курсорная пагинация: страницы без повторов и пропусков', async () => {
    const { root } = await categories();
    const { seller } = await shop();
    const all: string[] = [];
    for (let i = 0; i < 5; i++)
      all.push((await product(seller, { title: `Лампа ${i}`, categoryId: root })).productId);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof search>> = await search({
        categoryId: root,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...ids(page));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(all.sort());
    expect((await api().get('/catalog/search').query({ cursor: 'garbage' })).status).toBe(400);
  });

  it('отклонённый товар не находится; правка опубликованного снимает его до модерации', async () => {
    const { root } = await categories();
    const { seller } = await shop();
    const tag = newId().slice(-6);
    const draft = await as(seller).post('/seller/products', {
      title: `Утюг ${tag}`,
      categoryId: root,
    });
    const productId = draft.body.productId as string;
    await as(seller).post(`/seller/products/${productId}/skus`, {
      skuCode: `U-${tag}`,
      priceMinor: 1,
    });
    await as(seller).post(`/seller/products/${productId}/submit`);
    expect(
      (await as(admin).post(`/admin/products/${productId}/reject`, { reason: 'нет фото' })).status,
    ).toBe(200);
    expect(ids(await search({ q: tag }))).toEqual([]);

    const live = await product(seller, { title: `Пылесос ${tag}`, categoryId: root });
    const edited = await as(seller).patch(`/seller/products/${live.productId}`, {
      title: `Пылесос ${tag} новый`,
    });
    expect(edited.body.status).toBe('on_review');
    expect(ids(await search({ q: tag }))).toEqual([]);
    expect((await api().get(`/catalog/products/${live.productId}`)).status).toBe(404);
    expect(await outboxTypes(live.productId)).toEqual(['product.published', 'product.unpublished']);
  });

  it('блокировка магазина: товары сняты (seller_blocked), карточки нет, кабинет — 403', async () => {
    const { root } = await categories();
    const { sellerId, seller } = await shop();
    const live = await product(seller, { title: 'Миксер', categoryId: root });
    expect((await api().get(`/catalog/products/${live.productId}`)).status).toBe(200);
    expect(
      (await as(admin).post(`/admin/sellers/${sellerId}/block`, { reason: 'жалобы' })).status,
    ).toBe(200);
    expect(await outboxTypes(live.productId)).toEqual(['product.published', 'product.unpublished']);
    const unpublished = await prisma.outbox.findFirst({
      where: { messageKey: live.productId },
      orderBy: { id: 'desc' },
    });
    expect((unpublished?.payload as { payload: { reason: string } }).payload.reason).toBe(
      'seller_blocked',
    );
    expect((await api().get(`/catalog/products/${live.productId}`)).status).toBe(404);
    // токен ещё с правами, но магазин заблокирован
    expect(
      (await as(seller).patch(`/seller/products/${live.productId}`, { title: 'x' })).status,
    ).toBe(403);
  });

  it('изоляция: чужой товар — 404; каждый эндпоинт кабинета без права catalog — 403', async () => {
    const { root } = await categories();
    const a = await shop();
    const b = await shop();
    const live = await product(a.seller, { title: 'Тостер', categoryId: root });
    for (const res of [
      await as(b.seller).get(`/seller/products/${live.productId}`),
      await as(b.seller).patch(`/seller/products/${live.productId}`, { title: 'моё' }),
      await as(b.seller).post(`/seller/products/${live.productId}/archive`),
      await as(b.seller).patch(`/seller/products/${live.productId}/skus/${live.skus[0].skuId}`, {
        priceMinor: 1,
      }),
    ]) {
      expect(res.status).toBe(404);
    }
    const clerk = await token({
      sub: newId(),
      roles: ['buyer', 'seller_manager'],
      sellerId: a.sellerId,
      scopes: ['orders'],
    });
    for (const { method, path } of sellerEndpoints(app)) {
      const url = path.replace(/:[a-zA-Z]+/g, newId());
      const res = await api()
        [method.toLowerCase() as 'get'](url)
        .auth(clerk, { type: 'bearer' })
        .send({});
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
    }
  });

  it('админка: не админу — 403; категории — дерево', async () => {
    const { seller } = await shop();
    expect((await as(seller).get('/admin/sellers')).status).toBe(403);
    const { root, child } = await categories();
    const tree = (await api().get('/catalog/categories')).body as {
      categoryId: string;
      children: { categoryId: string }[];
    }[];
    expect(tree.find((n) => n.categoryId === root)?.children.map((c) => c.categoryId)).toEqual([
      child,
    ]);
  });

  it('seed: демо-каталог опубликован событиями, повтор ничего не меняет', async () => {
    const client = prisma as unknown as PrismaClient;
    expect(await seedCatalog(client)).toBeGreaterThan(0);
    expect(await seedCatalog(client)).toBe(0);
    const [phone] = DEV_CATALOG;
    expect(await outboxTypes(phone.productId)).toEqual(['product.published']);
    expect((await api().get(`/catalog/products/${phone.productId}`)).body.skus).toEqual([
      expect.objectContaining({ skuId: phone.skuId, priceMinor: phone.priceMinor }),
    ]);
    expect(ids(await search({ q: 'смартфон' }))).toContain(phone.productId);
  });
});
