import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Классы Tailwind без конфликтов: последний `px-*` побеждает, как в shadcn/ui. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
