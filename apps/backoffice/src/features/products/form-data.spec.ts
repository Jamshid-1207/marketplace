import { SkuRequest } from '@repo/contracts';
import {
  attributesText,
  categoryOptions,
  changedContent,
  contentFromForm,
  parseAttributes,
  skuFromForm,
} from './form-data';

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describe('формы товара (SD-08, п. 3.2)', () => {
  it('атрибуты: «ключ: значение» по строке, туда и обратно', () => {
    const attributes = parseAttributes('Цвет: чёрный\n\n Память : 256 ГБ \nВремя: 12:30');
    expect(attributes).toEqual({ Цвет: 'чёрный', Память: '256 ГБ', Время: '12:30' });
    expect(parseAttributes(attributesText(attributes ?? {}))).toEqual(attributes);
    expect(parseAttributes('')).toEqual({});
    for (const bad of ['без двоеточия', ': значение', 'ключ:']) {
      expect(parseAttributes(bad)).toBeNull();
    }
  });

  it('категории — путь от корня в порядке дерева', () => {
    const tree = [
      {
        categoryId: 'a',
        name: 'Электроника',
        children: [{ categoryId: 'b', name: 'Смартфоны', children: [] }],
      },
      { categoryId: 'c', name: 'Дом', children: [] },
    ];
    expect(categoryOptions(tree).map((o) => o.label)).toEqual([
      'Электроника',
      'Электроника / Смартфоны',
      'Дом',
    ]);
  });

  it('в PATCH текста — только изменённые поля', () => {
    const current = {
      productId: '01930000-0000-7000-8000-000000000001',
      sellerId: '01930000-0000-7000-8000-000000000002',
      title: 'Чайник',
      description: 'Белый',
      categoryId: '01930000-0000-7000-8000-000000000003',
      images: ['https://img.test/1.jpg'],
      status: 'published' as const,
      rejectionReason: null,
      skus: [],
    };
    const same = { ...current, images: [...current.images] };
    expect(changedContent(current, same)).toEqual({});
    expect(changedContent(current, { ...same, title: 'Чайник 2', images: [] })).toEqual({
      title: 'Чайник 2',
      images: [],
    });
  });

  it('текст товара и SKU из формы', () => {
    expect(
      contentFromForm(
        form({ title: 'Чайник', description: '', categoryId: 'x', images: ' a \n\nb' }),
      ),
    ).toEqual({ title: 'Чайник', description: '', categoryId: 'x', images: ['a', 'b'] });

    const sku = skuFromForm(
      form({ skuCode: 'K-1', attributes: 'Цвет: белый', price: '299 000', active: 'on' }),
    );
    expect(SkuRequest.parse(sku)).toEqual({
      skuCode: 'K-1',
      attributes: { Цвет: 'белый' },
      priceMinor: 299_000_00,
      active: true,
    });
    const broken = skuFromForm(form({ skuCode: 'K-2', attributes: 'плохо', price: 'дёшево' }));
    expect(broken).toMatchObject({ attributes: null, priceMinor: null, active: false });
    expect(SkuRequest.safeParse(broken).success).toBe(false);
    expect(SkuRequest.safeParse({ ...sku, attributes: null }).success).toBe(false);
  });
});
