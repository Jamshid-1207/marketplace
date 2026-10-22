import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ACCESS_TOKEN_TTL_SECONDS, DevTokenIssuer, Public } from '@repo/auth';
import { devUser } from '@repo/contracts';
import { z } from 'zod';

const LoginBody = z.object({ user: z.string().min(1).max(50) });

/**
 * Заглушка входа до этапа 5 (SD-02, п. 3.1): токен тестового пользователя из
 * `libs/contracts/src/dev`. Есть только при `DEV_AUTH=true`.
 */
@Controller('dev')
@UseGuards(ThrottlerGuard)
export class DevLoginController {
  constructor(private readonly issuer: DevTokenIssuer) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown) {
    const parsed = LoginBody.safeParse(body);
    const user = parsed.success ? devUser(parsed.data.user) : undefined;
    if (!user) throw new BadRequestException('неизвестный тестовый пользователь');
    const accessToken = await this.issuer.issue({
      sub: user.userId,
      roles: user.roles,
      ...(user.sellerId ? { sellerId: user.sellerId } : {}),
      scopes: user.scopes,
    });
    return { accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }
}
