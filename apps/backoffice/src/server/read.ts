import 'server-only';
import { notFound, redirect } from 'next/navigation';
import type { z } from 'zod';
import { gateway, GatewayError } from './gateway';

/**
 * Данные страницы кабинета: `404` сервиса — страница «не найдено», `403` — «нет доступа»
 * (SD-08, п. 3.4). Остальные сбои — в `error.tsx`: без этих данных страницы нет.
 */
export async function load<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  try {
    return await gateway(path, { schema });
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) notFound();
    if (error instanceof GatewayError && error.status === 403) redirect('/forbidden');
    throw error;
  }
}
