import type { SessionCookies } from '@repo/web-session';

/** Cookie сессии кабинета: на одном хосте cookie не различают порты, у витрины — свои (SD-08, решение 3). */
export const COOKIES: SessionCookies = { access: 'bo_access', refresh: 'bo_refresh' };
