import { getRequestConfig } from 'next-intl/server';
import messages from './ru.json';

/**
 * Тексты интерфейса — next-intl (SD-07, решение 10). Локаль пока одна, без префикса в URL;
 * узбекская — после MVP (ТЗ, 3.8), ключи уже есть.
 */
export default getRequestConfig(async () => ({
  locale: 'ru',
  messages,
  timeZone: 'Asia/Tashkent',
}));
