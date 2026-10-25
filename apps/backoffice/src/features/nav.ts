import type { MeResponse, SellerPermission } from '@repo/contracts';

/** Разделы кабинета и право, которое их открывает (SD-08, п. 3.1–3.2). */
export const SELLER_SECTIONS = [
  { key: 'products', href: '/products', permission: 'catalog' },
  { key: 'stock', href: '/stock', permission: 'warehouse' },
  { key: 'orders', href: '/orders', permission: 'orders' },
  { key: 'finance', href: '/finance', permission: 'finance' },
  { key: 'customers', href: '/customers', permission: 'support' },
  { key: 'staff', href: '/staff', permission: 'staff' },
] as const satisfies readonly { key: string; href: string; permission: SellerPermission }[];

export type SellerSection = (typeof SELLER_SECTIONS)[number]['key'];

export const ADMIN_SECTIONS = [
  { key: 'sellers', href: '/admin/sellers' },
  { key: 'moderation', href: '/admin/products' },
  { key: 'categories', href: '/admin/categories' },
  { key: 'commission', href: '/admin/commission' },
  { key: 'customers', href: '/admin/customers' },
] as const;

/** Магазины с этими статусами работают в кабинете; отклонённые и заблокированные — нет (SD-05). */
const CABINET_STATUSES = ['pending', 'active'];

export interface Access {
  /** Магазин пользователя, если он владелец или сотрудник. */
  shop: NonNullable<MeResponse['seller']> | null;
  /** Разделы кабинета по правам — из `GET /auth/me`, а не из токена (SD-08, п. 3.1). */
  sellerSections: (typeof SELLER_SECTIONS)[number][];
  admin: boolean;
  /** Своего магазина нет — можно открыть. */
  canOpenShop: boolean;
}

/** Меню — только подсказка: доступ к данным всё равно проверяют сервисы (ADR-0006, п. 4). */
export function access(me: MeResponse): Access {
  const shop = me.seller;
  const working = shop !== null && CABINET_STATUSES.includes(shop.status);
  return {
    shop,
    sellerSections: working
      ? SELLER_SECTIONS.filter((section) => shop.scopes.includes(section.permission))
      : [],
    admin: me.roles.includes('admin'),
    canOpenShop: shop === null,
  };
}

/** Есть ли у пользователя раздел кабинета. */
export const hasSection = (a: Access, key: SellerSection) =>
  a.sellerSections.some((section) => section.key === key);
