import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Admin } from '@repo/auth';
import { z } from 'zod';
import { CategoriesService } from '../application/categories.service';
import { ProductsService } from '../application/products.service';
import { SellersService } from '../application/sellers.service';
import { PRODUCT_STATUSES } from '../domain/product';
import { SELLER_STATUSES, type SellerDecision } from '../domain/seller';
import { PrismaCatalogReader } from '../infrastructure/prisma-catalog.reader';
import { http, parse } from './http';

const Reason = z.object({ reason: z.string().trim().min(1).max(500).optional() });
const Rejection = z.object({ reason: z.string().trim().min(1).max(500) });
const CategoryBody = z.object({
  name: z.string().trim().min(1).max(200),
  parentId: z.uuid().optional(),
});
const RenameBody = z.object({ name: z.string().trim().min(1).max(200) });

const uuid = () => new ParseUUIDPipe();

/** Модерация и категории (SD-05, п. 6.2–6.3): только роль `admin`. */
@Controller('admin')
@Admin()
export class AdminController {
  constructor(
    private readonly sellers: SellersService,
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
    private readonly reader: PrismaCatalogReader,
  ) {}

  @Get('sellers')
  listSellers(@Query('status') status?: string) {
    return this.reader.sellers(parse(z.enum(SELLER_STATUSES).optional(), status));
  }

  @Post('sellers/:id/:decision')
  @HttpCode(200)
  decide(
    @Param('id', uuid()) sellerId: string,
    @Param('decision') decision: string,
    @Body() body: unknown,
  ) {
    const d = parse(z.enum(['approve', 'reject', 'block']), decision) as SellerDecision;
    return http(() => this.sellers.decide(sellerId, d, parse(Reason, body ?? {}).reason));
  }

  @Get('products')
  listProducts(@Query('status') status?: string) {
    return this.reader.products({
      status: parse(z.enum(PRODUCT_STATUSES), status ?? 'on_review'),
    });
  }

  @Post('products/:id/approve')
  @HttpCode(200)
  approve(@Param('id', uuid()) productId: string) {
    return http(() => this.products.moderate(productId, { approve: true }));
  }

  @Post('products/:id/reject')
  @HttpCode(200)
  reject(@Param('id', uuid()) productId: string, @Body() body: unknown) {
    const { reason } = parse(Rejection, body);
    return http(() => this.products.moderate(productId, { approve: false, reason }));
  }

  @Post('categories')
  createCategory(@Body() body: unknown) {
    return http(() => this.categories.create(parse(CategoryBody, body)));
  }

  @Patch('categories/:id')
  renameCategory(@Param('id', uuid()) categoryId: string, @Body() body: unknown) {
    return http(() => this.categories.rename(categoryId, parse(RenameBody, body).name));
  }
}
