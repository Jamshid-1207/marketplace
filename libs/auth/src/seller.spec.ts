import { Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { newId } from '@repo/contracts';
import request from 'supertest';
import { AuthModule } from './auth.module';
import type { Claims } from './claims';
import { DevTokenIssuer } from './dev-issuer';
import {
  CurrentSeller,
  SellerScope,
  sellerEndpoints,
  sellerScope,
  type SellerAccess,
} from './seller';

const shop = newId();
const owner: Claims = { sub: newId(), roles: ['buyer', 'seller'], sellerId: shop, scopes: [] };
const manager: Claims = {
  sub: newId(),
  roles: ['buyer', 'seller_manager'],
  sellerId: shop,
  scopes: ['orders'],
};
const buyer: Claims = { sub: newId(), roles: ['buyer'], scopes: [] };

describe('sellerScope', () => {
  it('владелец — все права своего магазина', () => {
    expect(sellerScope(owner, 'warehouse')).toEqual({ kind: 'seller', sellerId: shop, scopes: [] });
  });

  it('сотрудник — только выданные права', () => {
    expect(sellerScope(manager, 'orders').sellerId).toBe(shop);
    expect(() => sellerScope(manager, 'warehouse')).toThrow('Forbidden');
  });

  it('покупатель и токен без магазина — 403', () => {
    expect(() => sellerScope(buyer, 'orders')).toThrow('Forbidden');
    expect(() => sellerScope({ ...owner, sellerId: undefined }, 'orders')).toThrow('Forbidden');
  });
});

@Controller('seller/warehouses')
class WarehousesProbe {
  @Get()
  @SellerScope('warehouse')
  list(@CurrentSeller() seller: SellerAccess) {
    return seller;
  }

  @Post(':id/archive')
  @SellerScope('warehouse')
  archive() {
    return {};
  }

  @Get('public-info')
  notSeller() {
    return {};
  }
}

@Controller()
class OrdersProbe {
  @Post('seller/sub-orders/:id/ship')
  @SellerScope('orders')
  ship(@CurrentSeller() seller: SellerAccess) {
    return seller;
  }
}

describe('@SellerScope по HTTP', () => {
  let app: INestApplication;
  let issuer: DevTokenIssuer;

  beforeAll(async () => {
    issuer = await DevTokenIssuer.create();
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule.forRoot({ jwks: issuer.jwks() })],
      controllers: [WarehousesProbe, OrdersProbe],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  const as = async (claims: Claims) => `Bearer ${await issuer.issue(claims)}`;

  it('область продавца — из токена; сотрудник без права — 403; покупатель — 403', async () => {
    const http = request(app.getHttpServer());
    const res = await http.get('/seller/warehouses').set('Authorization', await as(owner));
    expect(res.body).toEqual({ kind: 'seller', sellerId: shop, scopes: [] });
    expect(
      (await http.get('/seller/warehouses').set('Authorization', await as(manager))).status,
    ).toBe(403);
    expect(
      (await http.post('/seller/sub-orders/1/ship').set('Authorization', await as(manager))).status,
    ).toBe(201);
    expect(
      (await http.get('/seller/warehouses').set('Authorization', await as(buyer))).status,
    ).toBe(403);
    expect((await http.get('/seller/warehouses')).status).toBe(401);
  });

  it('список эндпоинтов кабинета — из метаданных декоратора', () => {
    expect(sellerEndpoints(app)).toEqual(
      expect.arrayContaining([
        { method: 'GET', path: '/seller/warehouses', permission: 'warehouse' },
        { method: 'POST', path: '/seller/warehouses/:id/archive', permission: 'warehouse' },
        { method: 'POST', path: '/seller/sub-orders/:id/ship', permission: 'orders' },
      ]),
    );
    expect(sellerEndpoints(app)).toHaveLength(3);
  });
});
