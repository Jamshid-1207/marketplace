import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Admin, CurrentSeller, SellerScope, type SellerAccess } from '@repo/auth';
import {
  CommissionRateRequest,
  CommissionReportQuery,
  PayoutRequest,
  SellerOperationsQuery,
  type CommissionRate,
  type CommissionReport,
  type FinanceSummary,
  type LedgerCheck,
  type PayoutRequested,
  type PayoutView,
  type SellerBalance,
  type SellerOperations,
} from '@repo/contracts';
import { z } from 'zod';
import type { FinanceReader } from '../application/finance';
import { CONFIG, type Config } from '../config';
import {
  InsufficientFundsError,
  PayoutService,
  PayoutTooSmallError,
} from '../application/payout.service';

export const FINANCE_READER = Symbol('FINANCE_READER');

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(z.prettifyError(result.error));
  return result.data;
}

/** Финансы в кабинете продавца (SD-04, п. 8). Право — `finance`. */
@Controller('seller')
export class SellerFinanceController {
  constructor(
    @Inject(FINANCE_READER) private readonly finance: FinanceReader,
    private readonly payouts: PayoutService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get('finance/balance')
  @SellerScope('finance')
  /** Баланс и правила выплат: минимальная сумма и срок удержания (SD-08, решение 8). */
  async balance(@CurrentSeller() seller: SellerAccess): Promise<SellerBalance> {
    return {
      ...(await this.finance.balance(seller.sellerId)),
      minPayoutMinor: this.config.MIN_PAYOUT_MINOR,
      holdMs: this.config.SELLER_HOLD_MS,
    };
  }

  @Get('finance/operations')
  @SellerScope('finance')
  async operations(
    @CurrentSeller() seller: SellerAccess,
    @Query() query: unknown,
  ): Promise<SellerOperations> {
    const { cursor, limit } = parse(SellerOperationsQuery, query);
    const items = await this.finance.operations(seller.sellerId, { before: cursor ?? null, limit });
    return { items, nextCursor: items.length === limit ? (items.at(-1)?.entryId ?? null) : null };
  }

  @Get('finance/summary')
  @SellerScope('finance')
  summary(@CurrentSeller() seller: SellerAccess): Promise<FinanceSummary> {
    return this.finance.summary(seller.sellerId);
  }

  @Get('payouts')
  @SellerScope('finance')
  list(@CurrentSeller() seller: SellerAccess): Promise<PayoutView[]> {
    return this.finance.payouts(seller.sellerId);
  }

  @Post('payouts')
  @SellerScope('finance')
  async request(
    @CurrentSeller() seller: SellerAccess,
    @Body() body: unknown,
  ): Promise<PayoutRequested> {
    const { amountMinor } = parse(PayoutRequest, body);
    try {
      const payout = await this.payouts.request(seller.sellerId, amountMinor);
      return { payoutId: payout.payoutId, amountMinor, status: payout.status };
    } catch (error) {
      if (error instanceof InsufficientFundsError) throw new ConflictException(error.message);
      if (error instanceof PayoutTooSmallError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }
}

/** Админка платформы: ставки комиссии, отчёт, сверка журнала (SD-04, п. 4). Только `admin`. */
@Controller('admin')
@Admin()
export class AdminFinanceController {
  constructor(@Inject(FINANCE_READER) private readonly finance: FinanceReader) {}

  @Get('commission-rates')
  rates(): Promise<CommissionRate[]> {
    return this.finance.rates();
  }

  @Put('commission-rates/:categoryId')
  async setRate(
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CommissionRate> {
    if (categoryId !== '*' && !z.uuid().safeParse(categoryId).success) {
      throw new NotFoundException('категория не найдена');
    }
    const { rateBp } = parse(CommissionRateRequest, body);
    if (!(await this.finance.setRate(categoryId, rateBp))) {
      throw new NotFoundException('категория не найдена');
    }
    return { categoryId, rateBp };
  }

  @Get('reports/commission')
  report(@Query() query: unknown): Promise<CommissionReport> {
    const { from, to } = parse(CommissionReportQuery, query);
    return this.finance.commissionReport(new Date(from), new Date(to));
  }

  @Get('ledger/check')
  check(): Promise<LedgerCheck> {
    return this.finance.checkLedger();
  }
}
