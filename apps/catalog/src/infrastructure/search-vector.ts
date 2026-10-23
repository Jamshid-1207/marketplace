import { toSearchLatin } from '../domain/translit';
import { Prisma } from '../generated/prisma/client';

/**
 * Поисковый вектор товара (SD-05, п. 6.4): русский со стеммингом и латинская форма словарём
 * `simple` (решение 4). Заголовок — вес A, описание — B.
 */
export function searchVector(title: string, description: string): Prisma.Sql {
  return Prisma.sql`
    setweight(to_tsvector('russian', ${title}), 'A')
    || setweight(to_tsvector('simple', ${toSearchLatin(title)}), 'A')
    || setweight(to_tsvector('russian', ${description}), 'B')
    || setweight(to_tsvector('simple', ${toSearchLatin(description)}), 'B')`;
}
