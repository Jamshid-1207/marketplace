import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CurrentClaims, Public, type Claims } from '@repo/auth';
import { z } from 'zod';
import { AccountsService } from '../application/accounts.service';
import { http, parse } from './http';

const RegisterBody = z.object({
  email: z.email().max(254),
  // argon2 не ограничивает длину, но ограничение защищает от дорогих хешей огромных строк
  password: z.string().min(8).max(128),
});
// при входе политика паролей не проверяется: иначе ответ отличался бы от неверного пароля
const LoginBody = z.object({ email: z.string().max(254), password: z.string().max(128) });
const RefreshBody = z.object({ refreshToken: z.string().min(1).max(200) });

/** Учётные записи и токены (SD-05, п. 5.3). Перебор паролей сдерживает rate limit gateway. */
@Controller('auth')
export class AuthController {
  constructor(private readonly accounts: AccountsService) {}

  @Public()
  @Post('register')
  register(@Body() body: unknown) {
    return http(() => this.accounts.register(parse(RegisterBody, body)));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    return http(() => this.accounts.login(parse(LoginBody, body)));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown) {
    return http(() => this.accounts.refresh(parse(RefreshBody, body).refreshToken));
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: unknown): Promise<void> {
    await this.accounts.logout(parse(RefreshBody, body).refreshToken);
  }

  @Get('me')
  me(@CurrentClaims() claims: Claims) {
    return http(() => this.accounts.me(claims.sub));
  }
}
