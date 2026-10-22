import { Controller, Get } from '@nestjs/common';
import { DevTokenIssuer, Public } from '@repo/auth';

/**
 * Публичные ключи заглушки входа (SD-02, п. 3.1): по ним сервисы проверяют токены до этапа 5.
 * Ключ эфемерный — перезапуск gateway делает старые токены недействительными.
 */
@Controller('.well-known')
export class JwksController {
  constructor(private readonly issuer: DevTokenIssuer) {}

  @Public()
  @Get('jwks.json')
  jwks() {
    return this.issuer.jwks();
  }
}
