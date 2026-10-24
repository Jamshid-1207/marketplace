'use client';

import { SkuLookupResponse } from '@repo/contracts';
import { useEffect, useState } from 'react';
import { CartItems } from './CartItems';
import {
  loadGuestCart,
  removeGuestLine,
  saveGuestCart,
  setGuestQty,
  type GuestLine,
} from './guest-cart';
import { guestItems } from './items';

/** Корзина гостя: строки — из браузера, цены и наличие — `/bff/skus` (SD-07, п. 5.3). */
export function GuestCart({ missing }: { missing: string[] }) {
  const [cart, setCart] = useState<GuestLine[] | null>(null);
  const [lookup, setLookup] = useState<SkuLookupResponse['items']>([]);

  useEffect(() => {
    setCart(loadGuestCart());
  }, []);

  const ids = cart?.map((line) => line.skuId).join(',') ?? '';
  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    fetch(`/bff/skus?ids=${ids}`)
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((body: unknown) => {
        if (!cancelled) setLookup(SkuLookupResponse.parse(body).items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ids]);

  if (cart === null) return null;
  const update = (next: GuestLine[]) => {
    saveGuestCart(next);
    setCart(next);
  };
  return (
    <CartItems
      items={guestItems(cart, lookup)}
      signedIn={false}
      missing={missing}
      onGuestQty={(skuId, qty) => update(setGuestQty(cart, skuId, qty))}
      onGuestRemove={(skuId) => update(removeGuestLine(cart, skuId))}
    />
  );
}
