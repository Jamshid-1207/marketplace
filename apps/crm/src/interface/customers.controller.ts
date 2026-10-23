import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { Admin, CurrentSeller, SellerScope, type SellerAccess } from '@repo/auth';
import { z } from 'zod';
import { CustomersService } from '../application/customers.service';
import type { Scope } from '../application/ports';
import { SEGMENTS } from '../domain/segment';

const ListQuery = z.object({
  segment: z.enum(SEGMENTS).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const AdminListQuery = ListQuery.extend({ email: z.string().max(254).optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(z.prettifyError(result.error));
  return result.data;
}

async function profile(customers: CustomersService, scope: Scope, buyerId: string) {
  const found = await customers.profile(scope, buyerId);
  // покупатель без заказов в магазине для продавца не существует (ADR-0006, п. 5)
  if (!found) throw new NotFoundException('покупатель не найден');
  return found;
}

/** CRM продавца (SD-06, п. 5.3): только его покупатели и их заказы у него, без контактов. */
@Controller('seller/customers')
export class SellerCustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @SellerScope('support')
  list(@CurrentSeller() seller: SellerAccess, @Query() query: unknown) {
    return this.customers.list(
      { kind: 'seller', sellerId: seller.sellerId },
      parse(ListQuery, query),
    );
  }

  @Get(':buyerId')
  @SellerScope('support')
  get(
    @CurrentSeller() seller: SellerAccess,
    @Param('buyerId', new ParseUUIDPipe()) buyerId: string,
  ) {
    return profile(this.customers, { kind: 'seller', sellerId: seller.sellerId }, buyerId);
  }
}

/** Профиль 360° и отчёт по сегментам для админа платформы (SD-06, п. 5.3, решение 8). */
@Controller('admin')
@Admin()
export class AdminCustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('customers')
  list(@Query() query: unknown) {
    return this.customers.list({ kind: 'platform' }, parse(AdminListQuery, query));
  }

  @Get('customers/:buyerId')
  get(@Param('buyerId', new ParseUUIDPipe()) buyerId: string) {
    return profile(this.customers, { kind: 'platform' }, buyerId);
  }

  @Get('reports/segments')
  segments() {
    return this.customers.segments();
  }
}
