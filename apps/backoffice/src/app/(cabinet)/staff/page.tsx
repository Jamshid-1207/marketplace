import { SellerPermission, StaffMember } from '@repo/contracts';
import { Badge, Button, Card, Input } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { ActionForm } from '../../../features/ActionForm';
import { Field } from '../../../features/fields';
import { hireStaff, removeStaff, setStaffScopes } from '../../../features/staff/actions';
import { requireSection } from '../../../server/access';
import { load } from '../../../server/read';

export const metadata = { title: 'Сотрудники' };

/** Права, которые владелец выдаёт сотруднику: `staff` — только у владельца (ADR-0006, п. 2). */
const GRANTABLE = SellerPermission.options.filter((p) => p !== 'staff');

async function ScopeBoxes({ checked = [] }: { checked?: readonly string[] }) {
  const t = await getTranslations('staff');
  return (
    <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      <legend className="sr-only">{t('scopes')}</legend>
      {GRANTABLE.map((scope) => (
        <label key={scope} className="flex items-center gap-2">
          <input
            type="checkbox"
            name="scopes"
            value={scope}
            defaultChecked={checked.includes(scope)}
          />
          {t(`scope.${scope}`)}
        </label>
      ))}
    </fieldset>
  );
}

/** Сотрудники магазина: добавить по email, права, убрать (SD-08, п. 3.2). Только владельцу. */
export default async function StaffPage() {
  await requireSection('staff');
  const t = await getTranslations('staff');
  const members = await load('/seller/staff', z.array(StaffMember));

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-slate-600">{t('hint')}</p>

      <Card className="space-y-4 p-6">
        {members.map((member) => (
          <div
            key={member.userId}
            role="group"
            aria-label={member.email}
            className="space-y-3 border-b border-slate-100 pb-4 last:border-0"
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{member.email}</span>
              <Badge tone={member.role === 'seller' ? 'brand' : 'neutral'}>
                {t(`role.${member.role}`)}
              </Badge>
            </div>
            {member.role === 'seller_manager' && (
              <div className="flex flex-wrap items-center gap-4">
                <ActionForm
                  action={setStaffScopes.bind(null, member.userId)}
                  className="flex flex-wrap items-center gap-4"
                >
                  <ScopeBoxes checked={member.scopes} />
                  <Button type="submit" variant="secondary" size="sm">
                    {t('save')}
                  </Button>
                </ActionForm>
                <ActionForm action={removeStaff.bind(null, member.userId)} saved={false}>
                  <Button type="submit" variant="ghost" size="sm">
                    {t('remove')}
                  </Button>
                </ActionForm>
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card role="region" aria-label={t('hire')} className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">{t('hire')}</h2>
        <ActionForm action={hireStaff} saved={false} resetOnSuccess className="space-y-4">
          <Field label={t('email')} hint={t('emailHint')} className="max-w-sm">
            <Input name="email" type="email" maxLength={254} required />
          </Field>
          <ScopeBoxes checked={['orders']} />
          <Button type="submit">{t('hireButton')}</Button>
        </ActionForm>
      </Card>
    </div>
  );
}
