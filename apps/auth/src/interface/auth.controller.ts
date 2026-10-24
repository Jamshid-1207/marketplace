import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CurrentClaims, Public, type Claims } from '@repo/auth';
import { LoginRequest, RefreshRequest, RegisterRequest } from '@repo/contracts';
import { AccountsService } from '../application/accounts.service';
import { http, parse } from './http';

/** Учётные записи и токены (SD-05, п. 5.3). Перебор паролей сдерживает rate limit gateway. */
@Controller('auth')
export class AuthController {
  constructor(private readonly accounts: AccountsService) {}

  @Public()
  @Post('register')
  register(@Body() body: unknown) {
    return http(() => this.accounts.register(parse(RegisterRequest, body)));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    return http(() => this.accounts.login(parse(LoginRequest, body)));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown) {
    return http(() => this.accounts.refresh(parse(RefreshRequest, body).refreshToken));
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: unknown): Promise<void> {
    await this.accounts.logout(parse(RefreshRequest, body).refreshToken);
  }

  @Get('me')
  me(@CurrentClaims() claims: Claims) {
    return http(() => this.accounts.me(claims.sub));
  }
}
