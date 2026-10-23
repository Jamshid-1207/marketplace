import { newId } from '@repo/contracts';
import {
  approve,
  archive,
  changeContent,
  changeOffer,
  ProductRuleError,
  reject,
  sellerBlocked,
  submit,
  type Product,
  type ProductStatus,
  type Sku,
} from './product';

const sku = (overrides: Partial<Sku> = {}): Sku => ({
  skuId: newId(),
  skuCode: `SKU-${newId().slice(-6)}`,
  attributes: {},
  priceMinor: 100_00,
  active: true,
  ...overrides,
});

const product = (status: ProductStatus, overrides: Partial<Product> = {}): Product => ({
  productId: newId(),
  sellerId: newId(),
  title: 'Чайник',
  description: '',
  categoryId: newId(),
  images: [],
  status,
  rejectionReason: null,
  version: 3,
  skus: [sku()],
  ...overrides,
});

describe('товар: переходы модерации (SD-05, п. 6.3)', () => {
  it('черновик: правка без события', () => {
    const { product: next, effect } = changeContent(product('draft'), { title: 'Новый' });
    expect([next.status, next.title, next.version, effect]).toEqual(['draft', 'Новый', 3, null]);
  });

  it('отправка на модерацию: draft и rejected → on_review', () => {
    expect(submit(product('draft')).product.status).toBe('on_review');
    const again = submit(product('rejected', { rejectionReason: 'плохое фото' })).product;
    expect([again.status, again.rejectionReason]).toEqual(['on_review', null]);
  });

  it('без SKU на модерацию нельзя', () => {
    expect(() => submit(product('draft', { skus: [] }))).toThrow('нет SKU');
  });

  it.each(['on_review', 'published', 'archived'] as const)('из %s на модерацию нельзя', (s) => {
    expect(() => submit(product(s))).toThrow(ProductRuleError);
  });

  it('одобрение: on_review → published, product.published, версия +1', () => {
    const { product: next, effect } = approve(product('on_review'), true);
    expect([next.status, next.version, effect]).toEqual(['published', 4, { kind: 'published' }]);
  });

  it('одобрение товара неактивного магазина — ошибка', () => {
    expect(() => approve(product('on_review'), false)).toThrow('не активен');
  });

  it('отклонение: on_review → rejected с причиной, без события', () => {
    const { product: next, effect } = reject(product('on_review'), 'нет описания');
    expect([next.status, next.rejectionReason, effect]).toEqual(['rejected', 'нет описания', null]);
  });

  it('правка текста опубликованного: снят до модерации (rejected_change)', () => {
    const { product: next, effect } = changeContent(product('published'), { title: 'Другой' });
    expect([next.status, next.version]).toEqual(['on_review', 4]);
    expect(effect).toEqual({ kind: 'unpublished', reason: 'rejected_change' });
  });

  it('новый SKU у опубликованного — тоже на модерацию', () => {
    const p = product('published');
    const { product: next, effect } = changeContent(p, {}, [...p.skus, sku()]);
    expect([next.status, next.skus.length, effect?.kind]).toEqual(['on_review', 2, 'unpublished']);
  });

  it('повтор кода SKU в товаре — ошибка данных', () => {
    const p = product('draft');
    const error = (() => {
      try {
        changeContent(p, {}, [...p.skus, sku({ skuCode: p.skus[0].skuCode })]);
      } catch (e) {
        return e as ProductRuleError;
      }
      return undefined;
    })();
    expect(error?.kind).toBe('invalid');
  });

  it('цена опубликованного: сразу, product.published', () => {
    const p = product('published');
    const { product: next, effect } = changeOffer(p, p.skus[0].skuId, { priceMinor: 90_00 }, true);
    expect([next.status, next.skus[0].priceMinor, next.version]).toEqual(['published', 90_00, 4]);
    expect(effect).toEqual({ kind: 'published' });
  });

  it('незаданное поле предложения не меняется', () => {
    const p = product('published');
    const offer = { priceMinor: 90_00, active: undefined };
    const { product: next } = changeOffer(p, p.skus[0].skuId, offer, true);
    expect(next.skus[0]).toMatchObject({ priceMinor: 90_00, active: true });
  });

  it('цена у заблокированного магазина — без события', () => {
    const p = product('published');
    expect(changeOffer(p, p.skus[0].skuId, { active: false }, false).effect).toBeNull();
  });

  it('цена черновика — без события', () => {
    const p = product('draft');
    expect(changeOffer(p, p.skus[0].skuId, { priceMinor: 1 }, true).effect).toBeNull();
  });

  it('чужой SKU — ошибка', () => {
    expect(() => changeOffer(product('draft'), newId(), { active: false }, true)).toThrow(
      'SKU нет в товаре',
    );
  });

  it('архив опубликованного: product.unpublished (archived)', () => {
    const { product: next, effect } = archive(product('published'));
    expect([next.status, effect]).toEqual([
      'archived',
      { kind: 'unpublished', reason: 'archived' },
    ]);
  });

  it('архив черновика — без события; архивный не правится', () => {
    expect(archive(product('draft')).effect).toBeNull();
    expect(() => changeContent(product('archived'), { title: 'x' })).toThrow('в архиве');
    expect(() => archive(product('archived'))).toThrow(ProductRuleError);
  });

  it('блокировка магазина: опубликованный снимается (seller_blocked), статус тот же', () => {
    const { product: next, effect } = sellerBlocked(product('published'));
    expect([next.status, effect]).toEqual([
      'published',
      { kind: 'unpublished', reason: 'seller_blocked' },
    ]);
    expect(sellerBlocked(product('draft')).effect).toBeNull();
  });
});
