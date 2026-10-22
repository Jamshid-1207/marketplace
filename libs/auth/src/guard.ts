import {
  createParamDecorator,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PUBLIC_ROUTE } from '@repo/observability';
import type { AccessScope, Claims } from './claims';
import { JwtVerifier } from './verifier';

/** Эндпоинт без токена: webhook провайдера (его подлинность проверяется подписью). Health открыт сам. */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  claims?: Claims;
}

/** Глобальный guard: без валидного `Authorization: Bearer` — `401`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly verifier: JwtVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null;
    if (!match) throw new UnauthorizedException();
    try {
      request.claims = await this.verifier.verify(match[1]);
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}

function claimsOf(context: ExecutionContext): Claims {
  const claims = context.switchToHttp().getRequest<AuthenticatedRequest>().claims;
  // guard уже отработал; отсутствие claims — ошибка в коде (эндпоинт помечен @Public)
  if (!claims) throw new UnauthorizedException();
  return claims;
}

export function buyerScope(claims: Claims): AccessScope & { kind: 'buyer' } {
  if (!claims.roles.includes('buyer')) throw new ForbiddenException();
  return { kind: 'buyer', userId: claims.sub };
}

/** Проверенные claims текущего запроса. */
export const CurrentClaims = createParamDecorator((_: unknown, context: ExecutionContext) =>
  claimsOf(context),
);

/** Область доступа покупателя (ADR-0006, п. 5); без роли `buyer` — `403`. */
export const BuyerScope = createParamDecorator((_: unknown, context: ExecutionContext) =>
  buyerScope(claimsOf(context)),
);
