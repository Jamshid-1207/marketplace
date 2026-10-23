import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { runInNewChain } from '@repo/observability';
import { PinoLogger } from 'nestjs-pino';
import { AccountsService } from '../application/accounts.service';
import { CONFIG, RUN_MODE, type Config, type RunMode } from '../config';

/** Первый админ из `ADMIN_EMAIL`, `ADMIN_PASSWORD` при старте (решение 5 SD-05). */
@Injectable()
export class AdminBootstrap implements OnApplicationBootstrap {
  constructor(
    private readonly accounts: AccountsService,
    private readonly log: PinoLogger,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RUN_MODE) private readonly mode: RunMode,
  ) {
    this.log.setContext('admin-bootstrap');
  }

  async onApplicationBootstrap(): Promise<void> {
    const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = this.config;
    if (this.mode !== 'server' || !email || !password) return;
    const result = await runInNewChain(() => this.accounts.ensureAdmin({ email, password }));
    this.log.info({ email, result }, 'админ платформы');
  }
}
