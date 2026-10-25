import type { MeResponse } from '@repo/contracts';
import messages from '../i18n/ru.json';
import { access, ADMIN_SECTIONS, hasSection, SELLER_SECTIONS } from './nav';

const me = (changes: Partial<MeResponse>): MeResponse => ({
  userId: '01930000-0000-7000-8000-000000000001',
  email: 'u@e2e.test',
  roles: ['buyer'],
  seller: null,
  ...changes,
});
const shop = (role: string, scopes: string[], status = 'active') => ({
  sellerId: '01930000-0000-7000-8000-00000000a000',
  role,
  scopes,
  status,
});
const keys = (m: MeResponse) => access(m).sellerSections.map((s) => s.key);

describe('меню кабинета по ролям и правам (SD-08, п. 3.1)', () => {
  it('владелец — все разделы, включая сотрудников', () => {
    const owner = me({
      roles: ['buyer', 'seller'],
      seller: shop('seller', ['catalog', 'warehouse', 'orders', 'support', 'finance', 'staff']),
    });
    expect(keys(owner)).toEqual(['products', 'stock', 'orders', 'finance', 'customers', 'staff']);
    expect(access(owner).canOpenShop).toBe(false);
  });

  it('сотрудник — только разделы своих прав', () => {
    const manager = me({
      roles: ['buyer', 'seller_manager'],
      seller: shop('seller_manager', ['orders', 'warehouse']),
    });
    expect(keys(manager)).toEqual(['stock', 'orders']);
    expect(hasSection(access(manager), 'finance')).toBe(false);
  });

  it('магазин на модерации работает, отклонённый и заблокированный — нет', () => {
    expect(keys(me({ seller: shop('seller', ['catalog'], 'pending') }))).toEqual(['products']);
    expect(keys(me({ seller: shop('seller', ['catalog'], 'rejected') }))).toEqual([]);
    expect(keys(me({ seller: shop('seller', ['catalog'], 'blocked') }))).toEqual([]);
  });

  it('без магазина — только «Открыть магазин»; админ видит админку', () => {
    expect(access(me({}))).toMatchObject({ sellerSections: [], canOpenShop: true, admin: false });
    expect(access(me({ roles: ['buyer', 'admin'] })).admin).toBe(true);
  });

  it('у каждого раздела и роли в магазине есть перевод', () => {
    for (const { key } of [...SELLER_SECTIONS, ...ADMIN_SECTIONS]) {
      expect(messages.nav).toHaveProperty(key);
    }
    expect(Object.keys(messages.shop.role).sort()).toEqual(['seller', 'seller_manager']);
  });
});
