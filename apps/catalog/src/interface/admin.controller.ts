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
import {
  CategoryRequest,
  ProductStatus,
  RejectProductRequest,
  RenameCategoryRequest,
  SellerDecision,
  SellerDecisionRequest,
  SellerStatus,
  type AdminShopView,
  type CabinetProduct,
  type CategoryView,
  type ShopView,
} from '@repo/contracts';
import { CategoriesService } from '../application/categories.service';
import { ProductsService } from '../application/products.service';
import { SellersService } from '../application/sellers.service';
import { PrismaCatalogReader } from '../infrastructure/prisma-catalog.reader';
import { http, parse } from './http';

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
  listSellers(@Query('status') status?: string): Promise<AdminShopView[]> {
    return this.reader.sellers(parse(SellerStatus.optional(), status));
  }

  @Post('sellers/:id/:decision')
  @HttpCode(200)
  decide(
    @Param('id', uuid()) sellerId: string,
    @Param('decision') decision: string,
    @Body() body: unknown,
  ): Promise<ShopView> {
    const d = parse(SellerDecision, decision);
    return http(() =>
      this.sellers.decide(sellerId, d, parse(SellerDecisionRequest, body ?? {}).reason),
    );
  }

  @Get('products')
  listProducts(@Query('status') status?: string): Promise<CabinetProduct[]> {
    return this.reader.products({
      status: parse(ProductStatus, status ?? 'on_review'),
    });
  }

  @Post('products/:id/approve')
  @HttpCode(200)
  approve(@Param('id', uuid()) productId: string): Promise<CabinetProduct> {
    return http(() => this.products.moderate(productId, { approve: true }));
  }

  @Post('products/:id/reject')
  @HttpCode(200)
  reject(@Param('id', uuid()) productId: string, @Body() body: unknown): Promise<CabinetProduct> {
    const { reason } = parse(RejectProductRequest, body);
    return http(() => this.products.moderate(productId, { approve: false, reason }));
  }

  @Post('categories')
  createCategory(@Body() body: unknown): Promise<CategoryView> {
    return http(() => this.categories.create(parse(CategoryRequest, body)));
  }

  @Patch('categories/:id')
  renameCategory(
    @Param('id', uuid()) categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryView> {
    return http(() => this.categories.rename(categoryId, parse(RenameCategoryRequest, body).name));
  }
}
