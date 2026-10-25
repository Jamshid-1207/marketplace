import { CustomerProfile } from '@repo/contracts';
import { CustomerCard } from '../../../../features/customers/CustomerViews';
import { requireSection } from '../../../../server/access';
import { load } from '../../../../server/read';

type Props = { params: Promise<{ buyerId: string }> };

export const metadata = { title: 'Покупатель' };

export default async function CustomerPage({ params }: Props) {
  await requireSection('customers');
  const { buyerId } = await params;
  const profile = await load(`/seller/customers/${encodeURIComponent(buyerId)}`, CustomerProfile);
  return <CustomerCard profile={profile} base="/customers" admin={false} />;
}
