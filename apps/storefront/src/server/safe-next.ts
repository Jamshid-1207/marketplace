/**
 * Куда вернуть покупателя после входа: только путь этой витрины. Иначе `?next=https://...`
 * превратил бы вход в открытый редирект.
 */
export function safeNext(next: string | undefined | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')
    ? next
    : '/';
}
