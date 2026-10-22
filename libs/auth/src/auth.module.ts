import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './guard';
import { JwtVerifier, type VerifierOptions } from './verifier';

/** Проверка JWT во всём приложении; исключения помечаются `@Public()`. */
@Module({})
export class AuthModule {
  static forRoot(options: VerifierOptions): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      providers: [
        { provide: JwtVerifier, useValue: new JwtVerifier(options) },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [JwtVerifier],
    };
  }
}
