import type { SessionCookies } from '@repo/web-session';

/** Cookie сессии витрины; у кабинета — свои (SD-08, решение 3). */
export const COOKIES: SessionCookies = { access: 'sf_access', refresh: 'sf_refresh' };
