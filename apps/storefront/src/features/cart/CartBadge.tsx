'use client';

import { useEffect, useState } from 'react';
import { GUEST_CART_EVENT, loadGuestCart } from './guest-cart';

/** Число позиций в корзине: у вошедшего — с сервера, у гостя — из браузера. */
export function CartBadge({ serverCount }: { serverCount: number | null }) {
  const [guestCount, setGuestCount] = useState(0);

  useEffect(() => {
    if (serverCount !== null) return;
    const update = () => setGuestCount(loadGuestCart().length);
    update();
    window.addEventListener(GUEST_CART_EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(GUEST_CART_EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, [serverCount]);

  const count = serverCount ?? guestCount;
  if (count === 0) return null;
  return (
    <span className="ml-1 rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white">
      {count}
    </span>
  );
}
