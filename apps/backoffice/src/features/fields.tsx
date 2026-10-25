import { cn } from '@repo/ui';
import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/** Поля форм кабинета — в стиле `Input` из `libs/ui`; витрине они не нужны (ADR-0003, п. 2). */
const FIELD =
  'w-full rounded-lg border border-slate-300 bg-white px-3 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(FIELD, 'py-2', className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(FIELD, 'h-10', className)} {...props} />;
}

/** Подпись над полем и подсказка под ним. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn('block space-y-1 text-sm', className)}>
      <span className="font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}
