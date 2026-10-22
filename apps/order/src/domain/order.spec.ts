import { DEV_CATALOG, DEV_SELLERS, money } from '@repo/contracts';
import { priceOrder, type CatalogItem } from './order';

const catalog = new Map<string, CatalogItem>(
  DEV_CATALOG.map((sku) => [
    sku.skuId,
    {
      skuId: sku.skuId,
      sellerId: sku.sellerId,
      title: sku.title,
      price: money(sku.priceMinor),
      categoryPath: sku.categoryPath,
      active: sku.active,
    },
  ]),
);
const [phone, cover, kettle, , inactive] = DEV_CATALOG;

let seq = 0;
const ids = () => `01930000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

describe('priceOrder', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('группирует позиции по продавцам, цены — из каталога, суммы сходятся', () => {
    const result = priceOrder(
      [
        { skuId: kettle.skuId, qty: 1 },
        { skuId: phone.skuId, qty: 1 },
        { skuId: cover.skuId, qty: 2 },
      ],
      catalog,
      ids,
    );
    if (!result.ok) throw new Error('ожидался расчёт');
    const { subOrders, total, lines } = result.order;
    expect(subOrders.map((s) => s.sellerId)).toEqual([DEV_SELLERS.A, DEV_SELLERS.B]);
    expect(subOrders[0].amount).toEqual(money(phone.priceMinor + 2 * cover.priceMinor));
    expect(subOrders[1].amount).toEqual(money(kettle.priceMinor));
    expect(total).toEqual(money(phone.priceMinor + 2 * cover.priceMinor + kettle.priceMinor));
    expect(lines.find((l) => l.skuId === cover.skuId)).toMatchObject({
      subOrderId: subOrders[0].subOrderId,
      title: cover.title,
      unitPrice: money(cover.priceMinor),
      qty: 2,
    });
  });

  it('неизвестные и снятые с продажи SKU — отказ со списком', () => {
    const unknown = '01930000-0000-7000-8000-00000000ffff';
    expect(
      priceOrder(
        [
          { skuId: phone.skuId, qty: 1 },
          { skuId: inactive.skuId, qty: 1 },
          { skuId: unknown, qty: 1 },
        ],
        catalog,
      ),
    ).toEqual({ ok: false, unavailable: [inactive.skuId, unknown] });
  });
});
