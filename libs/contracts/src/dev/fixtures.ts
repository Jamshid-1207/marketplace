/**
 * Демо-данные стенда и e2e (решение 6 SD-05): пользователей заводит seed auth, магазины,
 * категории и товары — seed catalog обычными событиями, склады и остатки — seed erp.
 * Id постоянные: сценарии e2e ссылаются на них.
 */

// UUID v7 с читаемым хвостом: a… — магазин A, b… — магазин B, c… — категории; …2xx — склады
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
  /** Вход — по email; пароль у всех тестовых пользователей общий, `DEV_USER_PASSWORD`. */
  email: string;
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
  {
    login: 'buyer-1',
    email: 'buyer-1@marketplace.test',
    userId: id('0b01'),
    roles: ['buyer'],
    scopes: [],
  },
  {
    login: 'buyer-2',
    email: 'buyer-2@marketplace.test',
    userId: id('0b02'),
    roles: ['buyer'],
    scopes: [],
  },
  {
    login: 'seller-a',
    email: 'seller-a@marketplace.test',
    userId: id('a001'),
    roles: ['buyer', 'seller'],
    sellerId: DEV_SELLERS.A,
    scopes: OWNER_SCOPES,
  },
  {
    login: 'seller-b',
    email: 'seller-b@marketplace.test',
    userId: id('b001'),
    roles: ['buyer', 'seller'],
    sellerId: DEV_SELLERS.B,
    scopes: OWNER_SCOPES,
  },
  // сотрудник магазина A только с правом заказов: проверки 403 в кабинете (ADR-0006, п. 8)
  {
    login: 'manager-a',
    email: 'manager-a@marketplace.test',
    userId: id('a002'),
    roles: ['buyer', 'seller_manager'],
    sellerId: DEV_SELLERS.A,
    scopes: ['orders'],
  },
  {
    login: 'admin',
    email: 'admin@marketplace.test',
    userId: id('ad01'),
    roles: ['buyer', 'admin'],
    scopes: [],
  },
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

export interface DevWarehouse {
  warehouseId: string;
  sellerId: string;
  name: string;
  /** Меньше — раньше: резерв берётся с первого склада, где хватает товара (ADR-0005, п. 8). */
  priority: number;
}

/** Склады seed-продавцов (SD-03, п. 4): у магазина A — основной и запасной. */
export const DEV_WAREHOUSES: readonly DevWarehouse[] = [
  { warehouseId: id('a201'), sellerId: DEV_SELLERS.A, name: 'Ташкент, основной', priority: 1 },
  { warehouseId: id('a202'), sellerId: DEV_SELLERS.A, name: 'Самарканд, запасной', priority: 2 },
  { warehouseId: id('b201'), sellerId: DEV_SELLERS.B, name: 'Ташкент', priority: 1 },
];

export interface DevStock {
  warehouseId: string;
  skuId: string;
  onHand: number;
}

const sku = (tail: string) => id(tail);

/** Начальные остатки seed-каталога: хватает на e2e, у снятого с продажи SKU — ноль. */
export const DEV_STOCK: readonly DevStock[] = [
  { warehouseId: id('a201'), skuId: sku('a101'), onHand: 1_000 },
  { warehouseId: id('a201'), skuId: sku('a102'), onHand: 1_000 },
  { warehouseId: id('a202'), skuId: sku('a102'), onHand: 100 },
  { warehouseId: id('b201'), skuId: sku('b101'), onHand: 1_000 },
  { warehouseId: id('b201'), skuId: sku('b102'), onHand: 1_000 },
];

export function devUser(login: string): DevUser | undefined {
  return DEV_USERS.find((user) => user.login === login);
}
