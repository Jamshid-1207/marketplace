import type { Claims, SellerAccess } from '@repo/auth';
import { newId } from '@repo/contracts';
import { InMemoryCatalog } from '../testing/in-memory-catalog';
import { CategoriesService, categoryTree } from './categories.service';
import { ConflictError, ForbiddenError, InvalidRequestError, NotFoundError } from './errors';
import { ProductsService } from './products.service';
import { SellersService } from './sellers.service';

function setup() {
  const repo = new InMemoryCatalog();
  const sellers = new SellersService(repo);
  const products = new ProductsService(repo);
  const categories = new CategoriesService(repo);
  const types = () => repo.published.map((p) => p.type);
  return { repo, sellers, products, categories, types };
}

const buyer = (): Claims => ({ sub: newId(), roles: ['buyer'], scopes: [] });
const access = (sellerId: string): SellerAccess => ({ kind: 'seller', sellerId, scopes: [] });

/** Активный магазин, категория и опубликованный товар с одним SKU. */
async function published(ctx: ReturnType<typeof setup>) {
  const shop = await ctx.sellers.register(buyer(), 'Магазин');
  await ctx.sellers.decide(shop.sellerId, 'approve');
  const root = await ctx.categories.create({ name: 'Дом' });
  const kitchen = await ctx.categories.create({ name: 'Кухня', parentId: root.categoryId });
  const seller = access(shop.sellerId);
  const draft = await ctx.products.create(seller, {
    title: 'Чайник',
    description: '',
    categoryId: kitchen.categoryId,
    images: [],
  });
  await ctx.products.addSku(seller, draft.productId, {
    skuCode: 'K-1',
    attributes: {},
    priceMinor: 100_00,
    active: true,
  });
  await ctx.products.submit(seller, draft.productId);
  const product = await ctx.products.moderate(draft.productId, { approve: true });
  return { seller, product, kitchen, root };
}

describe('catalog: use case’ы (SD-05, п. 6)', () => {
  it('регистрация магазина: pending и seller.registered; второй магазин и сотрудник — 409', async () => {
    const { sellers, repo } = setup();
    const owner = buyer();
    const shop = await sellers.register(owner, 'Магазин');
    expect(shop.status).toBe('pending');
    expect(repo.published[0]).toMatchObject({
      type: 'seller.registered',
      payload: { sellerId: shop.sellerId, ownerUserId: owner.sub, name: 'Магазин' },
      aggregate: { aggregateVersion: 1 },
    });
    await expect(sellers.register(owner, 'Ещё')).rejects.toBeInstanceOf(ConflictError);
    await expect(
      sellers.register({ ...buyer(), sellerId: newId() }, 'Сотрудник'),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('категории: путь от корня, category.created; переименование — category.updated v2', async () => {
    const { categories, repo } = setup();
    const root = await categories.create({ name: 'Электроника' });
    const phones = await categories.create({ name: 'Телефоны', parentId: root.categoryId });
    expect(phones.path).toEqual([root.categoryId, phones.categoryId]);
    await categories.rename(phones.categoryId, 'Смартфоны');
    expect(repo.published.at(-1)).toMatchObject({
      type: 'category.updated',
      payload: { name: 'Смартфоны', path: phones.path },
      aggregate: { aggregateVersion: 2 },
    });
    await expect(categories.create({ name: 'x', parentId: newId() })).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    expect(categoryTree([...repo.categories.values()])).toEqual([
      {
        categoryId: root.categoryId,
        name: 'Электроника',
        children: [{ categoryId: phones.categoryId, name: 'Смартфоны', children: [] }],
      },
    ]);
  });

  it('товар проходит модерацию: product.published с путём категории и ценой', async () => {
    const ctx = setup();
    const { product, kitchen } = await published(ctx);
    expect(product.status).toBe('published');
    const event = ctx.repo.published.at(-1);
    expect(event).toMatchObject({
      type: 'product.published',
      payload: {
        productId: product.productId,
        categoryPath: kitchen.path,
        skus: [{ skuCode: 'K-1', price: { amountMinor: 100_00, currency: 'UZS' }, active: true }],
      },
      aggregate: { aggregateVersion: 1 },
    });
  });

  it('товар магазина на модерации не одобрить — 409', async () => {
    const ctx = setup();
    const shop = await ctx.sellers.register(buyer(), 'Магазин');
    const cat = await ctx.categories.create({ name: 'Дом' });
    const seller = access(shop.sellerId);
    const draft = await ctx.products.create(seller, {
      title: 'Чайник',
      description: '',
      categoryId: cat.categoryId,
      images: [],
    });
    await ctx.products.addSku(seller, draft.productId, {
      skuCode: 'K-1',
      attributes: {},
      priceMinor: 1,
      active: true,
    });
    await ctx.products.submit(seller, draft.productId);
    await expect(ctx.products.moderate(draft.productId, { approve: true })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('цена опубликованного — сразу новый product.published; код SKU — снят до модерации', async () => {
    const ctx = setup();
    const { seller, product } = await published(ctx);
    const skuId = product.skus[0].skuId;
    await ctx.products.updateSku(seller, product.productId, skuId, { priceMinor: 90_00 });
    expect(ctx.repo.published.at(-1)).toMatchObject({
      type: 'product.published',
      aggregate: { aggregateVersion: 2 },
    });
    const changed = await ctx.products.updateSku(seller, product.productId, skuId, {
      skuCode: 'K-2',
    });
    expect(changed.status).toBe('on_review');
    expect(ctx.repo.published.at(-1)).toMatchObject({
      type: 'product.unpublished',
      payload: { reason: 'rejected_change' },
      aggregate: { aggregateVersion: 3 },
    });
  });

  it('блокировка магазина снимает опубликованные товары и закрывает кабинет', async () => {
    const ctx = setup();
    const { seller, product } = await published(ctx);
    await ctx.sellers.decide(seller.sellerId, 'block', 'жалобы');
    expect(ctx.types().slice(-2)).toEqual(['seller.blocked', 'product.unpublished']);
    expect(ctx.repo.published.at(-1)?.payload).toMatchObject({ reason: 'seller_blocked' });
    await expect(
      ctx.products.update(seller, product.productId, { title: 'Новое' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('чужой товар — 404; повтор кода SKU у продавца — 409', async () => {
    const ctx = setup();
    const { seller, product, kitchen } = await published(ctx);
    const other = await ctx.sellers.register(buyer(), 'Другой');
    await expect(
      ctx.products.update(access(other.sellerId), product.productId, { title: 'Моё' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const second = await ctx.products.create(seller, {
      title: 'Ещё чайник',
      description: '',
      categoryId: kitchen.categoryId,
      images: [],
    });
    await expect(
      ctx.products.addSku(seller, second.productId, {
        skuCode: 'K-1',
        attributes: {},
        priceMinor: 1,
        active: true,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('товар с несуществующей категорией — 400', async () => {
    const ctx = setup();
    const shop = await ctx.sellers.register(buyer(), 'Магазин');
    await expect(
      ctx.products.create(access(shop.sellerId), {
        title: 'Чайник',
        description: '',
        categoryId: newId(),
        images: [],
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });
});
