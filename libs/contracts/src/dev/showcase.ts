import { DEV_CATEGORIES, DEV_SELLERS } from './fixtures';

/**
 * Демо-витрина для ручного просмотра (SD-07, решение 12): товары магазинов A и B в
 * четырёх демо-категориях, с вариантами и остатками. Seed — при `SEED_SHOWCASE=true`;
 * e2e работает с `DEV_CATALOG` и этот набор не включает. Изображений нет: витрина рисует заглушку.
 *
 * Id: …e3NN — товар, …e1NNi — его SKU (i — номер варианта).
 */
const id = (tail: string) => `01930000-0000-7000-8000-${tail.padStart(12, '0')}`;
const hex = (n: number) => n.toString(16).padStart(2, '0');

export interface ShowcaseSku {
  skuId: string;
  skuCode: string;
  attributes: Record<string, string>;
  priceMinor: number;
  /** Остаток на основном складе продавца; 0 — «Нет в наличии» на витрине. */
  onHand: number;
}

export interface ShowcaseProduct {
  productId: string;
  sellerId: string;
  title: string;
  description: string;
  categoryPath: string[];
  skus: ShowcaseSku[];
}

/** Основной склад продавца из `DEV_WAREHOUSES`: остатки демо-витрины лежат на нём. */
export const SHOWCASE_WAREHOUSE: Record<string, string> = {
  [DEV_SELLERS.A]: id('a201'),
  [DEV_SELLERS.B]: id('b201'),
};

const phones = [DEV_CATEGORIES.electronics, DEV_CATEGORIES.phones];
const electronics = [DEV_CATEGORIES.electronics];
const kitchen = [DEV_CATEGORIES.home, DEV_CATEGORIES.kitchen];
const home = [DEV_CATEGORIES.home];

type Variant = [attributes: Record<string, string>, priceSum: number, onHand: number];

const items: [string, string, string, string[], Variant[]][] = [
  // магазин A — электроника
  [
    DEV_SELLERS.A,
    'Смартфон Nova 12, 6/128 ГБ',
    'Экран 6,5", две SIM-карты, NFC.',
    phones,
    [
      [{ цвет: 'чёрный' }, 2_490_000, 25],
      [{ цвет: 'синий' }, 2_490_000, 10],
      [{ цвет: 'зелёный' }, 2_590_000, 0],
    ],
  ],
  [
    DEV_SELLERS.A,
    'Смартфон Nova 12 Pro, 12/256 ГБ',
    'Тройная камера, зарядка 67 Вт.',
    phones,
    [
      [{ цвет: 'графит' }, 4_190_000, 8],
      [{ цвет: 'серебристый' }, 4_190_000, 3],
    ],
  ],
  [
    DEV_SELLERS.A,
    'Кнопочный телефон Classic',
    'Большие кнопки, громкий динамик, фонарик.',
    phones,
    [[{}, 249_000, 40]],
  ],
  [
    DEV_SELLERS.A,
    'Защитное стекло для Nova 12',
    'Полное покрытие экрана, олеофобное покрытие.',
    phones,
    [[{}, 39_000, 200]],
  ],
  [
    DEV_SELLERS.A,
    'Беспроводные наушники Pulse',
    'До 30 часов работы с кейсом, шумоподавление.',
    electronics,
    [
      [{ цвет: 'белый' }, 459_000, 30],
      [{ цвет: 'чёрный' }, 459_000, 30],
    ],
  ],
  [
    DEV_SELLERS.A,
    'Портативная колонка Bass Go',
    'Защита от воды IPX7, 12 часов музыки.',
    electronics,
    [[{}, 389_000, 0]],
  ],
  [
    DEV_SELLERS.A,
    'Умные часы Fit 3',
    'Пульс, сон, шаги; уведомления с телефона.',
    electronics,
    [
      [{ ремешок: 'силикон' }, 599_000, 15],
      [{ ремешок: 'металл' }, 699_000, 5],
    ],
  ],
  [
    DEV_SELLERS.A,
    'Зарядное устройство 65 Вт USB-C',
    'Быстрая зарядка телефона и ноутбука.',
    electronics,
    [[{}, 219_000, 60]],
  ],
  [
    DEV_SELLERS.A,
    'Пауэрбанк 20 000 мА·ч',
    'Два USB-A и один USB-C, индикатор заряда.',
    electronics,
    [[{}, 299_000, 25]],
  ],
  // магазин B — дом и кухня
  [
    DEV_SELLERS.B,
    'Чайник стеклянный с подсветкой',
    'Объём 1,7 л, автоотключение.',
    kitchen,
    [[{}, 279_000, 20]],
  ],
  [
    DEV_SELLERS.B,
    'Казан чугунный',
    'Для плова на большую семью, с крышкой.',
    kitchen,
    [
      [{ объём: '8 л' }, 690_000, 6],
      [{ объём: '12 л' }, 890_000, 4],
      [{ объём: '22 л' }, 1_290_000, 0],
    ],
  ],
  [
    DEV_SELLERS.B,
    'Набор пиал «Пахта»',
    'Шесть пиал с узбекским хлопковым узором.',
    kitchen,
    [[{}, 159_000, 35]],
  ],
  [
    DEV_SELLERS.B,
    'Ляган керамический',
    'Блюдо для плова, диаметр 40 см, ручная роспись.',
    kitchen,
    [
      [{ цвет: 'синий' }, 249_000, 12],
      [{ цвет: 'бирюзовый' }, 249_000, 0],
    ],
  ],
  [
    DEV_SELLERS.B,
    'Блендер погружной',
    'Мощность 800 Вт, насадка-венчик и чаша.',
    kitchen,
    [[{}, 349_000, 18]],
  ],
  [
    DEV_SELLERS.B,
    'Сковорода с антипригарным покрытием',
    'Подходит для индукционных плит.',
    kitchen,
    [
      [{ диаметр: '24 см' }, 189_000, 22],
      [{ диаметр: '28 см' }, 219_000, 14],
    ],
  ],
  [
    DEV_SELLERS.B,
    'Плед флисовый',
    'Размер 150×200 см, мягкий и тёплый.',
    home,
    [
      [{ цвет: 'бежевый' }, 139_000, 30],
      [{ цвет: 'серый' }, 139_000, 30],
    ],
  ],
  [
    DEV_SELLERS.B,
    'Настольная лампа LED',
    'Три режима яркости, сенсорное включение.',
    home,
    [[{}, 199_000, 0]],
  ],
  [
    DEV_SELLERS.B,
    'Сюзане настенное',
    'Вышивка ручной работы, 120×90 см.',
    home,
    [[{}, 1_490_000, 2]],
  ],
];

/** Цены — в сумах в таблице выше, в тийинах — в данных: 1 сум = 100 тийинов. */
export const DEV_SHOWCASE: readonly ShowcaseProduct[] = items.map(
  ([sellerId, title, description, categoryPath, variants], index) => {
    const n = hex(index + 1);
    return {
      productId: id(`e3${n}`),
      sellerId,
      title,
      description,
      categoryPath,
      skus: variants.map(([attributes, priceSum, onHand], i) => ({
        skuId: id(`e1${n}${i}`),
        skuCode: `E${n.toUpperCase()}-${i + 1}`,
        attributes,
        priceMinor: priceSum * 100,
        onHand,
      })),
    };
  },
);
