'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;

/**
 * `true`, когда React подхватил страницу. До этого форма с `onSubmit` отправилась бы браузером
 * сама — GET на тот же адрес, с паролем или адресом доставки в строке запроса. Кнопку отправки
 * держат неактивной, пока хук не вернёт `true`.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
