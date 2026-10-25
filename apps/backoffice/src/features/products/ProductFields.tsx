import type { CabinetProduct, CabinetSku } from '@repo/contracts';
import { Input } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { Field, Select, Textarea } from '../fields';
import { sumInput } from '../money';
import { attributesText } from './form-data';

/** Поля текста товара: создание и редактор (SD-08, п. 3.2). */
export async function ContentFields({
  product,
  categories,
}: {
  product?: CabinetProduct;
  categories: { categoryId: string; label: string }[];
}) {
  const t = await getTranslations('products');
  return (
    <div className="grid gap-4">
      <Field label={t('field.title')}>
        <Input name="title" defaultValue={product?.title} minLength={2} maxLength={300} required />
      </Field>
      <Field label={t('field.category')}>
        <Select name="categoryId" defaultValue={product?.categoryId ?? ''} required>
          <option value="" disabled>
            {t('field.categoryPick')}
          </option>
          {categories.map((c) => (
            <option key={c.categoryId} value={c.categoryId}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('field.description')}>
        <Textarea
          name="description"
          rows={5}
          maxLength={10_000}
          defaultValue={product?.description}
        />
      </Field>
      <Field label={t('field.images')} hint={t('field.imagesHint')}>
        <Textarea
          name="images"
          rows={3}
          defaultValue={product?.images.join('\n')}
          placeholder="https://"
        />
      </Field>
    </div>
  );
}

/** Поля SKU: строка таблицы редактора и форма нового SKU. */
export async function SkuFields({ sku }: { sku?: CabinetSku }) {
  const t = await getTranslations('products');
  return (
    <>
      <Field label={t('sku.code')} className="w-36">
        <Input name="skuCode" defaultValue={sku?.skuCode} maxLength={100} required />
      </Field>
      <Field label={t('sku.attributes')} hint={t('sku.attributesHint')} className="min-w-48 flex-1">
        <Textarea name="attributes" rows={2} defaultValue={sku && attributesText(sku.attributes)} />
      </Field>
      <Field label={t('sku.price')} className="w-36">
        <Input
          name="price"
          inputMode="decimal"
          defaultValue={sku && sumInput(sku.priceMinor)}
          pattern="[0-9 ]+([,.][0-9]{1,2})?"
          required
        />
      </Field>
      <label className="flex items-center gap-2 self-center text-sm">
        <input type="checkbox" name="active" defaultChecked={sku?.active ?? true} />
        {t('sku.active')}
      </label>
    </>
  );
}
