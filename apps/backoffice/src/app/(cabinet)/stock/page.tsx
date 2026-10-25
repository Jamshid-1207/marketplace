import { CabinetProduct, StockLevels, WarehouseView } from '@repo/contracts';
import { Badge, Button, Card, Input } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ActionForm } from '../../../features/ActionForm';
import { Field, Select } from '../../../features/fields';
import {
  adjustStock,
  createWarehouse,
  setThreshold,
  updateWarehouse,
} from '../../../features/stock/actions';
import { stockRows } from '../../../features/stock/rows';
import { requireSection } from '../../../server/access';
import { gateway, optional } from '../../../server/gateway';
import { load } from '../../../server/read';

export const metadata = { title: 'Склады и остатки' };

/**
 * Склады и остатки (SD-08, п. 3.2). Названия товаров — синхронным чтением catalog рядом с erp
 * (решение 5); catalog недоступен — строки по id SKU.
 */
export default async function StockPage() {
  await requireSection('stock');
  const t = await getTranslations('stock');
  const [warehouses, levels, products] = await Promise.all([
    load('/seller/warehouses', z.array(WarehouseView)),
    load('/seller/stock', StockLevels),
    optional(
      () => gateway('/seller/products', { schema: z.array(CabinetProduct), timeoutMs: 2_000 }),
      null,
    ),
  ]);
  const rows = stockRows(products, levels);
  const names = new Map(warehouses.map((w) => [w.warehouseId, w.name]));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>

      <Card role="region" aria-label={t('warehouses')} className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">{t('warehouses')}</h2>
        <p className="text-sm text-slate-600">{t('priorityHint')}</p>
        {warehouses.map((warehouse) => (
          <ActionForm
            key={warehouse.warehouseId}
            action={updateWarehouse.bind(null, warehouse.warehouseId)}
            className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4"
          >
            <Field label={t('name')} className="min-w-48 flex-1">
              <Input name="name" defaultValue={warehouse.name} maxLength={100} required />
            </Field>
            <Field label={t('priority')} className="w-28">
              <Input
                name="priority"
                type="number"
                min={1}
                max={1000}
                defaultValue={warehouse.priority}
                required
              />
            </Field>
            <label className="flex h-10 items-center gap-2 text-sm">
              <input type="checkbox" name="active" defaultChecked={warehouse.active} />
              {t('active')}
            </label>
            <Button type="submit" variant="secondary">
              {t('save')}
            </Button>
          </ActionForm>
        ))}
        <ActionForm
          action={createWarehouse}
          saved={false}
          resetOnSuccess
          className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4"
        >
          <Field label={t('newName')} className="min-w-48 flex-1">
            <Input name="name" maxLength={100} required />
          </Field>
          <Field label={t('priority')} className="w-28">
            <Input
              name="priority"
              type="number"
              min={1}
              max={1000}
              defaultValue={warehouses.length + 1}
              required
            />
          </Field>
          <Button type="submit">{t('create')}</Button>
        </ActionForm>
      </Card>

      <Card className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">{t('levels')}</h2>
        {products === null && <p className="text-sm text-amber-800">{t('noTitles')}</p>}
        {rows.length === 0 && <p className="text-sm text-slate-500">{t('empty')}</p>}
        {rows.map((row) => (
          <section
            key={row.skuId}
            aria-label={[row.title ?? row.skuId, row.skuCode].filter(Boolean).join(' ')}
            className="space-y-3 border-t border-slate-100 pt-4"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-medium">{row.title ?? row.skuId}</h3>
              {row.skuCode && <span className="text-sm text-slate-500">{row.skuCode}</span>}
              <span className="text-sm text-slate-500">
                {Object.values(row.attributes).join(', ')}
              </span>
              {row.low && <Badge tone="warning">{t('low')}</Badge>}
            </div>
            <table className="text-sm">
              <thead className="text-slate-500">
                <tr>
                  <th className="pr-6 text-left font-medium">{t('warehouse')}</th>
                  <th className="pr-6 text-right font-medium">{t('onHand')}</th>
                  <th className="pr-6 text-right font-medium">{t('reserved')}</th>
                  <th className="text-right font-medium">{t('available')}</th>
                </tr>
              </thead>
              <tbody>
                {row.byWarehouse.map((level) => (
                  <tr key={level.warehouseId}>
                    <td className="pr-6">{names.get(level.warehouseId) ?? level.warehouseId}</td>
                    <td className="pr-6 text-right">{level.onHand}</td>
                    <td className="pr-6 text-right">{level.reserved}</td>
                    <td className="text-right">{level.available}</td>
                  </tr>
                ))}
                <tr className="font-medium">
                  <td className="pr-6">{t('total')}</td>
                  <td className="pr-6 text-right">{row.onHand}</td>
                  <td className="pr-6 text-right">{row.reserved}</td>
                  <td className="text-right">{row.available}</td>
                </tr>
              </tbody>
            </table>
            <div className="flex flex-wrap gap-6">
              <ActionForm
                action={adjustStock.bind(null, row.skuId)}
                saved={false}
                resetOnSuccess
                className="flex flex-wrap items-end gap-3"
              >
                <Field label={t('warehouse')} className="w-48">
                  <Select name="warehouseId" required>
                    {warehouses
                      .filter((w) => w.active)
                      .map((w) => (
                        <option key={w.warehouseId} value={w.warehouseId}>
                          {w.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label={t('delta')} hint={t('deltaHint')} className="w-32">
                  <Input name="delta" type="number" step={1} required />
                </Field>
                <Field label={t('reason')} className="w-48">
                  <Input name="reason" maxLength={200} required />
                </Field>
                <Button type="submit" variant="secondary">
                  {t('adjust')}
                </Button>
              </ActionForm>
              <ActionForm
                action={setThreshold.bind(null, row.skuId)}
                className="flex flex-wrap items-end gap-3"
              >
                <Field label={t('threshold')} hint={t('thresholdHint')} className="w-32">
                  <Input
                    name="threshold"
                    type="number"
                    min={1}
                    defaultValue={row.threshold ?? undefined}
                    required
                  />
                </Field>
                <Button type="submit" variant="secondary">
                  {t('save')}
                </Button>
              </ActionForm>
            </div>
          </section>
        ))}
      </Card>
    </div>
  );
}
