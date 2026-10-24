import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '@repo/auth';
import {
  SearchQuery,
  SellerNamesQuery,
  SkuLookupQuery,
  type CategoryTree,
  type ProductCard,
  type SearchResponse,
  type SellerNamesResponse,
  type SkuLookupResponse,
} from '@repo/contracts';
import { categoryTree } from '../application/categories.service';
import { PrismaCatalogReader } from '../infrastructure/prisma-catalog.reader';
import { http, parse } from './http';

/**
 * Витрина каталога (SD-05, п. 6.4; SD-07, п. 4): публична, только опубликованные товары
 * активных магазинов. Запросы и ответы — схемы `libs/contracts`, по ним их читает storefront.
 */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly reader: PrismaCatalogReader) {}

  @Public()
  @Get('search')
  search(@Query() query: unknown): Promise<SearchResponse> {
    const { q, categoryId, minPrice, maxPrice, inStock, cursor, limit } = parse(SearchQuery, query);
    return http(() =>
      this.reader.search({
        q: q || undefined,
        categoryId,
        minPriceMinor: minPrice,
        maxPriceMinor: maxPrice,
        inStock,
        cursor,
        limit,
      }),
    );
  }

  @Public()
  @Get('products/:id')
  async product(@Param('id', new ParseUUIDPipe()) productId: string): Promise<ProductCard> {
    const card = await this.reader.card(productId);
    if (!card) throw new NotFoundException('товар не найден');
    return card;
  }

  @Public()
  @Get('categories')
  async categories(): Promise<CategoryTree> {
    return categoryTree(await this.reader.categories());
  }

  /** Строки корзины (SD-07, п. 5.3): SKU, которых нет в ответе, заказать нельзя. */
  @Public()
  @Get('skus')
  skus(@Query() query: unknown): Promise<SkuLookupResponse> {
    return this.reader.skus(parse(SkuLookupQuery, query).ids);
  }

  /** Названия магазинов для «Моих заказов» (SD-07, п. 3.2). */
  @Public()
  @Get('sellers')
  sellers(@Query() query: unknown): Promise<SellerNamesResponse> {
    return this.reader.sellerNames(parse(SellerNamesQuery, query).ids);
  }
}
