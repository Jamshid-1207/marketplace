import { ProductCard } from '@repo/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card, ProductImage } from '@repo/ui';
import { SkuPicker } from '../../../features/product/SkuPicker';
import { gateway, GatewayError } from '../../../server/gateway';
import { signedIn } from '../../../server/session';

type Props = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(id: string): Promise<ProductCard | null> {
  if (!UUID.test(id)) return null;
  try {
    return await gateway(`/catalog/products/${encodeURIComponent(id)}`, {
      schema: ProductCard,
      token: null,
    });
  } catch (error) {
    // неверный id — 400 от ParseUUIDPipe; снятый с продажи — 404
    if (error instanceof GatewayError && (error.status === 404 || error.status === 400)) {
      return null;
    }
    throw error;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const card = await load((await params).id).catch(() => null);
  return card ? { title: card.title } : {};
}

/** Карточка товара (SD-07, п. 3.2): опубликованный товар активного магазина. */
export default async function ProductPage({ params }: Props) {
  const t = await getTranslations('product');
  const card = await load((await params).id);
  if (!card) notFound();
  const [image, ...more] = card.images;

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <div className="space-y-3">
        <Card className="overflow-hidden">
          <ProductImage src={image} title={card.title} className="aspect-square w-full" />
        </Card>
        {more.length > 0 && (
          <div className="grid grid-cols-4 gap-2">
            {more.map((src) => (
              <Card key={src} className="overflow-hidden">
                <ProductImage src={src} title={card.title} className="aspect-square w-full" />
              </Card>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">{card.title}</h1>
          <p className="mt-1 text-sm text-slate-500">{t('seller', { name: card.sellerName })}</p>
        </div>
        <SkuPicker card={card} signedIn={await signedIn()} />
        {card.description && (
          <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">
            {card.description}
          </p>
        )}
      </div>
    </div>
  );
}
