import { cn } from './cn';

/** Заглушка вместо фото: у демо-товаров изображений нет (SD-07, решение 12). */
export function ImagePlaceholder({ title, className }: { title: string; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'flex items-center justify-center bg-gradient-to-br from-brand-50 to-slate-100 text-3xl font-semibold text-brand-600/60',
        className,
      )}
    >
      {title.trim().charAt(0).toUpperCase()}
    </div>
  );
}

/** Фото товара по ссылке или заглушка. Ссылки внешние: обычный `img`, без оптимизатора Next. */
export function ProductImage({
  src,
  title,
  className,
}: {
  src: string | null | undefined;
  title: string;
  className?: string;
}) {
  if (!src) return <ImagePlaceholder title={title} className={className} />;
  return <img src={src} alt={title} loading="lazy" className={cn('object-cover', className)} />;
}
