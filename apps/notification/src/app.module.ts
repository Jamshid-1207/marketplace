import { Module, type DynamicModule } from '@nestjs/common';
import { ObservabilityModule } from '@repo/observability';
import { NotificationModule } from './notification.module';
import { ConfigModule, SERVICE_NAME, type Config, type RunMode } from './config';
import { InfrastructureModule, readinessChecks } from './infrastructure/infrastructure.module';

@Module({})
export class AppModule {
  static forRoot(config: Config, mode: RunMode = 'server'): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config, mode),
        ObservabilityModule.forRoot({
          serviceName: SERVICE_NAME,
          level: config.LOG_LEVEL,
          pretty: config.LOG_PRETTY,
          readinessChecks,
          imports: [InfrastructureModule],
        }),
        InfrastructureModule,
        NotificationModule,
      ],
    };
  }
}
