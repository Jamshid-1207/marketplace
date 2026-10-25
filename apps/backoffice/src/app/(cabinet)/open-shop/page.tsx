import { redirect } from 'next/navigation';
import { OpenShopForm } from '../../../features/shop/OpenShopForm';
import { currentAccess } from '../../../server/access';

export const metadata = { title: 'Открыть магазин' };

/** Только у пользователя без магазина: в MVP магазин у пользователя один (ADR-0006, п. 1). */
export default async function OpenShopPage() {
  if (!(await currentAccess()).canOpenShop) redirect('/');
  return <OpenShopForm />;
}
