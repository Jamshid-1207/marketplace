import { Controller, Get } from '@nestjs/common';
import { Public } from '@repo/auth';
import { SigningKeys } from '../infrastructure/signing-keys';

/** Публичные ключи подписи (SD-05, п. 5.2): по ним токены проверяют gateway и все сервисы. */
@Controller('.well-known')
export class JwksController {
  constructor(private readonly keys: SigningKeys) {}

  @Public()
  @Get('jwks.json')
  jwks() {
    return this.keys.jwks();
  }
}
