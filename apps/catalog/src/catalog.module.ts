import { Module } from '@nestjs/common';
import { CategoriesService } from './application/categories.service';
import { ProductsService } from './application/products.service';
import { SellersService } from './application/sellers.service';
import { PrismaCatalogReader } from './infrastructure/prisma-catalog.reader';
import { PrismaCatalogRepository } from './infrastructure/prisma-catalog.repository';
import { StockReadModel } from './infrastructure/stock-read-model';
import { AdminController } from './interface/admin.controller';
import { CatalogController } from './interface/catalog.controller';
import { SellerProductsController } from './interface/seller-products.controller';
import { SellersController } from './interface/sellers.controller';
import { StockEventsHandler } from './interface/stock-events.handler';

const service = <T>(Type: new (repository: PrismaCatalogRepository) => T) => ({
  provide: Type,
  inject: [PrismaCatalogRepository],
  useFactory: (repository: PrismaCatalogRepository) => new Type(repository),
});

/** Продавцы, категории, товары, модерация и поиск (SD-05, п. 6); наличие из erp (SD-07, п. 6). */
@Module({
  controllers: [CatalogController, SellersController, SellerProductsController, AdminController],
  providers: [
    PrismaCatalogRepository,
    PrismaCatalogReader,
    service(SellersService),
    service(ProductsService),
    service(CategoriesService),
    StockReadModel,
    StockEventsHandler,
  ],
})
export class CatalogModule {}
