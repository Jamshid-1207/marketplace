import { CustomerProfile } from '@repo/contracts';
import { CustomerCard } from '../../../../../features/customers/CustomerViews';
import { requireAdmin } from '../../../../../server/access';
import { load } from '../../../../../server/read';

type Props = { params: Promise<{ buyerId: string }> };

export const metadata = { title: 'Покупатель' };

/** Профиль 360°: заказы во всех магазинах, email, оплаты и возвраты (SD-06, п. 5.3). */
export default async function AdminCustomerPage({ params }: Props) {
  await requireAdmin();
  const { buyerId } = await params;
  const profile = await load(`/admin/customers/${encodeURIComponent(buyerId)}`, CustomerProfile);
  return <CustomerCard profile={profile} base="/admin/customers" admin />;
}
