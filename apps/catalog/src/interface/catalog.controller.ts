import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '@repo/auth';
import { z } from 'zod';
import { categoryTree } from '../application/categories.service';
import { PrismaCatalogReader } from '../infrastructure/prisma-catalog.reader';
import { http, parse } from './http';

const price = z.coerce.number().int().min(0).refine(Number.isSafeInteger);
const SearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  categoryId: z.uuid().optional(),
  minPrice: price.optional(),
  maxPrice: price.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Витрина каталога (SD-05, п. 6.4): публична, только опубликованные товары активных магазинов. */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly reader: PrismaCatalogReader) {}

  @Public()
  @Get('search')
  search(@Query() query: unknown) {
    const { q, categoryId, minPrice, maxPrice, cursor, limit } = parse(SearchQuery, query);
    return http(() =>
      this.reader.search({
        q: q || undefined,
        categoryId,
        minPriceMinor: minPrice,
        maxPriceMinor: maxPrice,
        cursor,
        limit,
      }),
    );
  }

  @Public()
  @Get('products/:id')
  async product(@Param('id', new ParseUUIDPipe()) productId: string) {
    const card = await this.reader.card(productId);
    if (!card) throw new NotFoundException('товар не найден');
    return card;
  }

  @Public()
  @Get('categories')
  async categories() {
    return categoryTree(await this.reader.categories());
  }
}
