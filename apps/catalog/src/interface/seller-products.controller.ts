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
import { z } from 'zod';
import { ProductsService } from '../application/products.service';
import { PrismaCatalogReader } from '../infrastructure/prisma-catalog.reader';
import { http, parse, PriceMinor } from './http';

const Content = z.object({
  title: z.string().trim().min(2).max(300),
  description: z.string().trim().max(10_000).default(''),
  categoryId: z.uuid(),
  images: z.array(z.url().max(500)).max(10).default([]),
});
const ContentChanges = z
  .object({
    title: z.string().trim().min(2).max(300),
    description: z.string().trim().max(10_000),
    categoryId: z.uuid(),
    images: z.array(z.url().max(500)).max(10),
  })
  .partial();
const Attributes = z.record(z.string().max(50), z.string().max(200)).default({});
const SkuBody = z.object({
  skuCode: z.string().trim().min(1).max(100),
  attributes: Attributes,
  priceMinor: PriceMinor,
  active: z.boolean().default(true),
});
const SkuChanges = z
  .object({
    skuCode: z.string().trim().min(1).max(100),
    attributes: z.record(z.string().max(50), z.string().max(200)),
    priceMinor: PriceMinor,
    active: z.boolean(),
  })
  .partial();

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
  list(@CurrentSeller() seller: SellerAccess) {
    return this.reader.products({ sellerId: seller.sellerId });
  }

  @Get(':id')
  @SellerScope('catalog')
  async get(@CurrentSeller() seller: SellerAccess, @Param('id', uuid()) productId: string) {
    const [product] = await this.reader.products({ sellerId: seller.sellerId, productId });
    if (!product) throw new NotFoundException('товар не найден');
    return product;
  }

  @Post()
  @SellerScope('catalog')
  create(@CurrentSeller() seller: SellerAccess, @Body() body: unknown) {
    return http(() => this.products.create(seller, parse(Content, body)));
  }

  @Patch(':id')
  @SellerScope('catalog')
  update(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', uuid()) productId: string,
    @Body() body: unknown,
  ) {
    return http(() => this.products.update(seller, productId, parse(ContentChanges, body)));
  }

  @Post(':id/skus')
  @SellerScope('catalog')
  addSku(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', uuid()) productId: string,
    @Body() body: unknown,
  ) {
    return http(() => this.products.addSku(seller, productId, parse(SkuBody, body)));
  }

  @Patch(':id/skus/:skuId')
  @SellerScope('catalog')
  updateSku(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', uuid()) productId: string,
    @Param('skuId', uuid()) skuId: string,
    @Body() body: unknown,
  ) {
    return http(() => this.products.updateSku(seller, productId, skuId, parse(SkuChanges, body)));
  }

  @Delete(':id/skus/:skuId')
  @SellerScope('catalog')
  removeSku(
    @CurrentSeller() seller: SellerAccess,
    @Param('id', uuid()) productId: string,
    @Param('skuId', uuid()) skuId: string,
  ) {
    return http(() => this.products.removeSku(seller, productId, skuId));
  }

  @Post(':id/submit')
  @HttpCode(200)
  @SellerScope('catalog')
  submit(@CurrentSeller() seller: SellerAccess, @Param('id', uuid()) productId: string) {
    return http(() => this.products.submit(seller, productId));
  }

  @Post(':id/archive')
  @HttpCode(200)
  @SellerScope('catalog')
  archive(@CurrentSeller() seller: SellerAccess, @Param('id', uuid()) productId: string) {
    return http(() => this.products.archive(seller, productId));
  }
}
