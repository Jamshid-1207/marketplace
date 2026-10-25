import {
  applyDecorators,
  createParamDecorator,
  ForbiddenException,
  Injectable,
  RequestMethod,
  SetMetadata,
  UseGuards,
  UseInterceptors,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import type { AccessScope, Claims, SellerPermission } from './claims';
import { TenantInterceptor } from './tenant';

export type SellerAccess = AccessScope & { kind: 'seller' };

const SELLER_PERMISSION = 'auth:seller-permission';

interface SellerRequest {
  claims?: Claims;
  sellerScope?: SellerAccess;
}

/**
 * Область продавца (ADR-0006, п. 2, 5) только из проверенного токена. Владелец (`seller`) имеет
 * все права своего магазина, сотрудник (`seller_manager`) — только выданные. Иначе `403`.
 */
export function sellerScope(claims: Claims, permission: SellerPermission): SellerAccess {
  const isOwner = claims.roles.includes('seller');
  const isManager = claims.roles.includes('seller_manager');
  if (!claims.sellerId || (!isOwner && !isManager)) throw new ForbiddenException();
  if (!isOwner && !claims.scopes.includes(permission)) throw new ForbiddenException();
  return { kind: 'seller', sellerId: claims.sellerId, scopes: claims.scopes };
}

@Injectable()
export class SellerGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.get<SellerPermission>(
      SELLER_PERMISSION,
      context.getHandler(),
    );
    const request = context.switchToHttp().getRequest<SellerRequest>();
    // глобальный AuthGuard уже проверил токен; без claims — эндпоинт ошибочно помечен @Public
    if (!request.claims) throw new ForbiddenException();
    request.sellerScope = sellerScope(request.claims, permission);
    return true;
  }
}

/**
 * Эндпоинт кабинета продавца с правом `permission`. Метаданные декоратора — источник списка
 * эндпоинтов для теста изоляции: новый эндпоинт попадает в проверку сам (ADR-0006, п. 8). Он же
 * включает режим магазина: запросы к базе — под RLS этого магазина (SD-09, п. 5).
 */
export const SellerScope = (permission: SellerPermission) =>
  applyDecorators(
    SetMetadata(SELLER_PERMISSION, permission),
    UseGuards(SellerGuard),
    UseInterceptors(TenantInterceptor),
  );

/** Область продавца текущего запроса; эндпоинт должен быть помечен `@SellerScope`. */
export const CurrentSeller = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const scope = context.switchToHttp().getRequest<SellerRequest>().sellerScope;
  if (!scope) throw new ForbiddenException();
  return scope;
});

export interface SellerEndpoint {
  method: string;
  /** Путь с параметрами: `/seller/warehouses/:id`. */
  path: string;
  permission: SellerPermission;
}

const joinPath = (...parts: (string | undefined)[]) =>
  '/' +
  parts
    .flatMap((part) => (part ?? '').split('/'))
    .filter(Boolean)
    .join('/');

/** Все эндпоинты приложения с `@SellerScope` — для теста изоляции кабинета. */
export function sellerEndpoints(app: INestApplication): SellerEndpoint[] {
  const endpoints: SellerEndpoint[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      if (!controller) continue;
      const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function') continue;
        const permission = Reflect.getMetadata(SELLER_PERMISSION, handler) as
          SellerPermission | undefined;
        if (!permission) continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
        endpoints.push({ method: RequestMethod[method], path: joinPath(prefix, path), permission });
      }
    }
  }
  return endpoints;
}
