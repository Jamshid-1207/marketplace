/**
 * Тестовые пользователи и seed-каталог на этапы 2–4, пока нет auth и catalog (ТЗ, раздел 8;
 * SD-02, п. 4). Их используют заглушка входа в gateway, seed order и e2e.
 * Удаляется на этапе 5 вместе с заглушкой.
 */

// UUID v7 с читаемым хвостом: a… — магазин A, b… — магазин B, c… — категории
const id = (tail: string) => `01930000-0000-7000-8000-${tail.padStart(12, '0')}`;

export const DEV_SELLERS = {
  A: id('a000'),
  B: id('b000'),
} as const;

export const DEV_CATEGORIES = {
  electronics: id('c001'),
  phones: id('c002'),
  home: id('c003'),
  kitchen: id('c004'),
} as const;

export interface DevUser {
  login: string;
  userId: string;
  roles: ('buyer' | 'seller' | 'seller_manager' | 'admin')[];
  sellerId?: string;
  scopes: ('catalog' | 'warehouse' | 'orders' | 'support' | 'finance' | 'staff')[];
}

const OWNER_SCOPES: DevUser['scopes'] = [
  'catalog',
  'warehouse',
  'orders',
  'support',
  'finance',
  'staff',
];

/** Покупать может любой пользователь, поэтому роль `buyer` есть у всех (ТЗ, раздел 2). */
export const DEV_USERS: readonly DevUser[] = [
  { login: 'buyer-1', userId: id('0b01'), roles: ['buyer'], scopes: [] },
  { login: 'buyer-2', userId: id('0b02'), roles: ['buyer'], scopes: [] },
  {
    login: 'seller-a',
    userId: id('a001'),
    roles: ['buyer', 'seller'],
    sellerId: DEV_SELLERS.A,
    scopes: OWNER_SCOPES,
  },
  {
    login: 'seller-b',
    userId: id('b001'),
    roles: ['buyer', 'seller'],
    sellerId: DEV_SELLERS.B,
    scopes: OWNER_SCOPES,
  },
  { login: 'admin', userId: id('ad01'), roles: ['buyer', 'admin'], scopes: [] },
];

export interface DevSku {
  skuId: string;
  sellerId: string;
  title: string;
  priceMinor: number;
  categoryPath: string[];
  active: boolean;
}

/** Цены — в тийинах: 1 сум = 100 тийинов. */
export const DEV_CATALOG: readonly DevSku[] = [
  {
    skuId: id('a101'),
    sellerId: DEV_SELLERS.A,
    title: 'Смартфон, 8/256 ГБ',
    priceMinor: 2_990_000_00,
    categoryPath: [DEV_CATEGORIES.electronics, DEV_CATEGORIES.phones],
    active: true,
  },
  {
    skuId: id('a102'),
    sellerId: DEV_SELLERS.A,
    title: 'Чехол силиконовый',
    priceMinor: 59_000_00,
    categoryPath: [DEV_CATEGORIES.electronics, DEV_CATEGORIES.phones],
    active: true,
  },
  {
    skuId: id('b101'),
    sellerId: DEV_SELLERS.B,
    title: 'Чайник электрический',
    priceMinor: 349_000_00,
    categoryPath: [DEV_CATEGORIES.home, DEV_CATEGORIES.kitchen],
    active: true,
  },
  {
    skuId: id('b102'),
    sellerId: DEV_SELLERS.B,
    title: 'Набор кастрюль',
    priceMinor: 899_000_00,
    categoryPath: [DEV_CATEGORIES.home, DEV_CATEGORIES.kitchen],
    active: true,
  },
  {
    skuId: id('b199'),
    sellerId: DEV_SELLERS.B,
    title: 'Снят с продажи',
    priceMinor: 10_000_00,
    categoryPath: [DEV_CATEGORIES.home],
    active: false,
  },
];

export function devUser(login: string): DevUser | undefined {
  return DEV_USERS.find((user) => user.login === login);
}
