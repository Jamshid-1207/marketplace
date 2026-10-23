import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentSeller, SellerPermission, SellerScope, type SellerAccess } from '@repo/auth';
import { z } from 'zod';
import { StaffService } from '../application/staff.service';
import { http, parse } from './http';

const Scopes = z.array(SellerPermission).min(1).max(SellerPermission.options.length);
const HireBody = z.object({ email: z.email().max(254), scopes: Scopes });
const ScopesBody = z.object({ scopes: Scopes });

/** Сотрудники магазина (SD-05, п. 5.3): право `staff` есть только у владельца. */
@Controller('seller/staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @SellerScope('staff')
  list(@CurrentSeller() seller: SellerAccess) {
    return this.staff.list(seller);
  }

  @Post()
  @SellerScope('staff')
  add(@CurrentSeller() seller: SellerAccess, @Body() body: unknown) {
    return http(() => this.staff.add(seller, parse(HireBody, body)));
  }

  @Put(':userId')
  @SellerScope('staff')
  update(
    @CurrentSeller() seller: SellerAccess,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: unknown,
  ) {
    return http(() => this.staff.update(seller, userId, parse(ScopesBody, body).scopes));
  }

  @Delete(':userId')
  @HttpCode(204)
  @SellerScope('staff')
  async remove(
    @CurrentSeller() seller: SellerAccess,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<void> {
    await http(() => this.staff.remove(seller, userId));
  }
}
