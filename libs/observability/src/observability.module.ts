import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type ModuleMetadata,
  type NestModule,
  type Type,
} from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { LoggerModule } from 'nestjs-pino';
import { CorrelationMiddleware } from './correlation';
import { HealthController, READINESS_CHECKS, type ReadinessCheck } from './health';
import { loggerParams, type LoggerOptions } from './logger';

export interface ObservabilityOptions extends LoggerOptions {
  /** Проверки для `/health/ready`. */
  readinessChecks?: Type<ReadinessCheck>[];
  /** Модули, от которых зависят проверки готовности (например, модуль с PrismaService). */
  imports?: ModuleMetadata['imports'];
}

/**
 * Логгер, контекст цепочки и health-эндпоинты одним модулем (SD-01, п. 6.2).
 * Трейсинг запускается отдельно и раньше: `initTelemetry` в `instrumentation.ts`.
 */
@Module({})
export class ObservabilityModule implements NestModule {
  static forRoot(options: ObservabilityOptions): DynamicModule {
    const checks = options.readinessChecks ?? [];
    return {
      module: ObservabilityModule,
      global: true,
      imports: [
        LoggerModule.forRoot(loggerParams(options)),
        TerminusModule,
        ...(options.imports ?? []),
      ],
      controllers: [HealthController],
      providers: [
        ...checks,
        {
          provide: READINESS_CHECKS,
          useFactory: (...instances: ReadinessCheck[]) => instances,
          inject: checks,
        },
      ],
      exports: [LoggerModule],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*splat}');
  }
}
