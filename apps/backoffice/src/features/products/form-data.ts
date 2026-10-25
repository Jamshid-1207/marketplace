import type { CabinetProduct, CategoryTree, ProductContentChanges } from '@repo/contracts';
import { parseSum } from '../money';

/**
 * Атрибуты SKU в поле ввода — по одному на строку, «ключ: значение». Пустые строки
 * пропускаются; строка без двоеточия, пустой ключ или значение — `null`.
 */
export function parseAttributes(text: string): Record<string, string> | null {
  const attributes: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (colon < 0 || !key || !value) return null;
    attributes[key] = value;
  }
  return attributes;
}

export const attributesText = (attributes: Record<string, string>) =>
  Object.entries(attributes)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

/** Ссылки на изображения — по одной на строку. */
export const parseImages = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** Категории для выбора: путь от корня через « / », в порядке дерева. */
export function categoryOptions(tree: CategoryTree): { categoryId: string; label: string }[] {
  return tree.flatMap((node) => [
    { categoryId: node.categoryId, label: node.name },
    ...categoryOptions(node.children).map((child) => ({
      categoryId: child.categoryId,
      label: `${node.name} / ${child.label}`,
    })),
  ]);
}

const text = (data: FormData, key: string) => String(data.get(key) ?? '');

/** Текст товара из формы: схема контракта проверит его в действии. */
export const contentFromForm = (data: FormData) => ({
  title: text(data, 'title'),
  description: text(data, 'description'),
  categoryId: text(data, 'categoryId'),
  images: parseImages(text(data, 'images')),
});

/**
 * Только изменённые поля текста: catalog отправляет опубликованный товар на модерацию при любом
 * `PATCH`, даже без изменений (SD-05, решение 3).
 */
export function changedContent(
  current: CabinetProduct,
  next: ProductContentChanges,
): ProductContentChanges {
  const changes: ProductContentChanges = {};
  if (next.title !== undefined && next.title !== current.title) changes.title = next.title;
  if (next.description !== undefined && next.description !== current.description) {
    changes.description = next.description;
  }
  if (next.categoryId !== undefined && next.categoryId !== current.categoryId) {
    changes.categoryId = next.categoryId;
  }
  if (next.images !== undefined && next.images.join('\n') !== current.images.join('\n')) {
    changes.images = next.images;
  }
  return changes;
}

/**
 * SKU из формы: цена в сумах, атрибуты строками. Не разобрались — `null`, и схема откажет; не
 * `undefined`: тогда `SkuRequest` молча подставил бы пустые атрибуты.
 */
export const skuFromForm = (data: FormData) => ({
  skuCode: text(data, 'skuCode'),
  attributes: parseAttributes(text(data, 'attributes')),
  priceMinor: parseSum(text(data, 'price')),
  active: data.get('active') === 'on',
});
