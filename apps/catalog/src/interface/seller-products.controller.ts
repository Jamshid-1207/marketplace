import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentSeller, SellerScope, type SellerAccess } from '@repo/auth';
import {
  ProductContentChanges,
  ProductContentRequest,
  SkuChanges,
  SkuRequest,
  type CabinetProduct,
} from '@repo/contracts';
import { ProductsService } from '../application/products.service';
import { PrismaCatalogReader } from '../infrastructure/prisma-catalog.reader';
import { http, parse } from './http';

const uuid = () => new ParseUUIDPipe();

/** Товары в кабинете продавца (SD-05, п. 6.3). Право — `catalog`; чужой товар — `404`. */
@Controller('seller/products')
export class SellerProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly reader: PrismaCatalogReader,
  ) {}

  @Get()
  @SellerScope('catalog')
  list(@CurrentSeller() seller: SellerAccess): Promise<CabinetProduct[]> {
    return this.reader.products({ sellerId: seller.sellerId });
  }

  @Get(':id')
  @SellerScope('catalog')
  async get(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', uuid()) productId: string,
  ): Promise<CabinetProduct> {
    const [product] = await this.reader.products({ sellerId: seller.sellerId, productId });
    if (!product) throw new NotFoundException('товар не найден');
    return product;
  }

  @Post()
  @SellerScope('catalog')
  create(@CurrentSeller() seller: SellerAccess, @Body() body: unknown): Promise<CabinetProduct> {
    return http(() => this.products.create(seller, parse(ProductContentRequest, body)));
  }

  @Patch(':id')
  @SellerScope('catalog')
  update(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', uuid()) productId: string,
    @Body() body: unknown,
  ): Promise<CabinetProduct> {
    return http(() => this.products.update(seller, productId, parse(ProductContentChanges, body)));
  }

  @Post(':id/skus')
  @SellerScope('catalog')
  addSku(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', uuid()) productId: string,
    @Body() body: unknown,
  ): Promise<CabinetProduct> {
    return http(() => this.products.addSku(seller, productId, parse(SkuRequest, body)));
  }

  @Patch(':id/skus/:skuId')
  @SellerScope('catalog')
  updateSku(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', uuid()) productId: string,
    @Param('skuId', uuid()) skuId: string,
    @Body() body: unknown,
  ): Promise<CabinetProduct> {
    return http(() => this.products.updateSku(seller, productId, skuId, parse(SkuChanges, body)));
  }

  @Delete(':id/skus/:skuId')
  @SellerScope('catalog')
  removeSku(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', uuid()) productId: string,
    @Param('skuId', uuid()) skuId: string,
  ): Promise<CabinetProduct> {
    return http(() => this.products.removeSku(seller, productId, skuId));
  }

  @Post(':id/submit')
  @HttpCode(200)
  @SellerScope('catalog')
  submit(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', uuid()) productId: string,
  ): Promise<CabinetProduct> {
    return http(() => this.products.submit(seller, productId));
  }

  @Post(':id/archive')
  @HttpCode(200)
  @SellerScope('catalog')
  archive(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', uuid()) productId: string,
  ): Promise<CabinetProduct> {
    return http(() => this.products.archive(seller, productId));
  }
}
