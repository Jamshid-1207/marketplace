import { Module, type DynamicModule } from '@nestjs/common';
import type { DevTokenIssuer } from '@repo/auth';
import { ObservabilityModule } from '@repo/observability';
import { ConfigModule, SERVICE_NAME, type Config, type RunMode } from './config';
import { GatewayModule } from './gateway.module';

@Module({})
export class AppModule {
  static forRoot(config: Config, issuer: DevTokenIssuer, mode: RunMode = 'server'): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config, mode),
        ObservabilityModule.forRoot({
          serviceName: SERVICE_NAME,
          level: config.LOG_LEVEL,
          pretty: config.LOG_PRETTY,
        }),
        GatewayModule.forRoot(config, issuer),
      ],
    };
  }
}
