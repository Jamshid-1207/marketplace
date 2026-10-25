import type { CategoryNode } from '@repo/contracts';
import Link from 'next/link';
import { cn } from '@repo/ui';

/** Дерево категорий: ссылка сохраняет запрос и фильтры, меняет только категорию. */
export function CategoryNav({
  nodes,
  active,
  href,
  depth = 0,
}: {
  nodes: CategoryNode[];
  active: string | undefined;
  href: (categoryId: string) => string;
  depth?: number;
}) {
  return (
    <ul className={cn('space-y-0.5', depth > 0 && 'ml-3 border-l border-slate-200 pl-2')}>
      {nodes.map((node) => (
        <li key={node.categoryId}>
          <Link
            href={href(node.categoryId)}
            className={cn(
              'block rounded-md px-2 py-1 text-sm hover:bg-slate-100',
              node.categoryId === active && 'bg-brand-50 font-medium text-brand-700',
            )}
          >
            {node.name}
          </Link>
          {node.children.length > 0 && (
            <CategoryNav nodes={node.children} active={active} href={href} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}
