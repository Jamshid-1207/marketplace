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
import { CurrentSeller, SellerScope, type SellerAccess } from '@repo/auth';
import { HireStaffRequest, StaffScopesRequest, type StaffMember } from '@repo/contracts';
import { StaffService } from '../application/staff.service';
import { http, parse } from './http';

/** Сотрудники магазина (SD-05, п. 5.3): право `staff` есть только у владельца. */
@Controller('seller/staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @SellerScope('staff')
  list(@CurrentSeller() seller: SellerAccess): Promise<StaffMember[]> {
    return this.staff.list(seller);
  }

  @Post()
  @SellerScope('staff')
  add(@CurrentSeller() seller: SellerAccess, @Body() body: unknown): Promise<StaffMember> {
    return http(() => this.staff.add(seller, parse(HireStaffRequest, body)));
  }

  @Put(':userId')
  @SellerScope('staff')
  update(
    @CurrentSeller() seller: SellerAccess,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: unknown,
  ): Promise<StaffMember> {
    return http(() => this.staff.update(seller, userId, parse(StaffScopesRequest, body).scopes));
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
