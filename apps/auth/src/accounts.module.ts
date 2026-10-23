import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, JwtVerifier } from '@repo/auth';
import { PinoLogger } from 'nestjs-pino';
import { AccountsService } from './application/accounts.service';
import { SellerEventsService } from './application/seller-events.service';
import { StaffService } from './application/staff.service';
import { CONFIG, type Config } from './config';
import { Argon2Hasher } from './infrastructure/argon2.hasher';
import { PrismaAccountsRepository } from './infrastructure/prisma-accounts.repository';
import { SigningKeys } from './infrastructure/signing-keys';
import { AdminBootstrap } from './interface/admin.bootstrap';
import { AuthController } from './interface/auth.controller';
import { JwksController } from './interface/jwks.controller';
import { MessagingHandlers } from './interface/messaging.handlers';
import { StaffController } from './interface/staff.controller';

const DAY_MS = 24 * 60 * 60_000;

/** Учётные записи, токены, сотрудники и членство в магазинах (SD-05, п. 5). */
@Module({
  controllers: [AuthController, StaffController, JwksController],
  providers: [
    PrismaAccountsRepository,
    SigningKeys,
    // свои токены auth проверяет по своему ключу, без запроса JWKS к себе
    {
      provide: JwtVerifier,
      inject: [SigningKeys],
      useFactory: (keys: SigningKeys) => new JwtVerifier({ keys: () => keys.jwks() }),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      provide: AccountsService,
      inject: [PrismaAccountsRepository, SigningKeys, CONFIG, PinoLogger],
      useFactory: (
        repository: PrismaAccountsRepository,
        keys: SigningKeys,
        config: Config,
        log: PinoLogger,
      ) => {
        log.setContext('accounts');
        return new AccountsService(
          repository,
          new Argon2Hasher(),
          keys,
          {
            accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
            refreshTtlMs: config.REFRESH_TOKEN_TTL_DAYS * DAY_MS,
          },
          log,
        );
      },
    },
    {
      provide: StaffService,
      inject: [PrismaAccountsRepository],
      useFactory: (repository: PrismaAccountsRepository) => new StaffService(repository),
    },
    {
      provide: SellerEventsService,
      inject: [PrismaAccountsRepository, PinoLogger],
      useFactory: (repository: PrismaAccountsRepository, log: PinoLogger) => {
        log.setContext('seller-events');
        return new SellerEventsService(repository, log);
      },
    },
    MessagingHandlers,
    AdminBootstrap,
  ],
})
export class AccountsModule {}
