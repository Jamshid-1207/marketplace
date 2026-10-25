import { cn } from '@repo/ui';
import Link from 'next/link';

/** Фильтр списка по статусу — ссылками: состояние в адресе, назад работает. */
export function StatusTabs<S extends string>({
  base,
  statuses,
  current,
  label,
  title,
}: {
  base: string;
  statuses: readonly S[];
  current: S;
  label: string;
  title: (status: S) => string;
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2 text-sm">
      {statuses.map((status) => (
        <Link
          key={status}
          href={`${base}?status=${status}`}
          aria-current={status === current ? 'page' : undefined}
          className={cn(
            'rounded-full border border-slate-300 px-3 py-1 hover:bg-slate-100',
            status === current && 'border-brand-500 bg-brand-50 text-brand-700',
          )}
        >
          {title(status)}
        </Link>
      ))}
    </nav>
  );
}
