import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtVerifier, sellerEndpoints, type Claims } from '@repo/auth';
import {
  devUser,
  newId,
  SellerApprovedV1,
  SellerBlockedV1,
  SellerRegisteredV1,
  type AnyMessageDefinition,
  type PayloadOf,
} from '@repo/contracts';
import { runInNewChain } from '@repo/observability';
import { outbox } from '@repo/outbox';
import { createTopics, eventually, testBrokers, testDatabaseUrl } from '@repo/testing';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { Argon2Hasher } from './infrastructure/argon2.hasher';
import { PrismaService } from './infrastructure/prisma.service';
import { seedDevUsers } from './infrastructure/seed-users';
import { SigningKeys } from './infrastructure/signing-keys';
import type { PrismaClient } from './generated/prisma/client';

const dev = (login: string) => {
  const user = devUser(login);
  if (!user) throw new Error(`нет тестового пользователя ${login}`);
  return user;
};

const ADMIN = { email: 'root@marketplace.test', password: 'root-password-1' };

/** auth через HTTP, Postgres и Kafka (SD-05, п. 8). Каждый тест заводит своих пользователей. */
describe('auth: учётные записи и токены (интеграция)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let verifier: JwtVerifier;

  const config = () =>
    loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      KAFKA_BROKERS: testBrokers().join(','),
      KAFKA_FROM_BEGINNING: 'true',
      ADMIN_EMAIL: ADMIN.email,
      ADMIN_PASSWORD: ADMIN.password,
    });

  async function start(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config())],
    }).compile();
    const instance = moduleRef.createNestApplication();
    await instance.listen(0);
    return instance;
  }

  beforeAll(async () => {
    await createTopics(
      { topic: 'auth.events' },
      { topic: 'catalog.events' },
      { topic: 'auth-service.dlq' },
    );
    app = await start();
    prisma = app.get(PrismaService);
    const { port } = app.getHttpServer().address() as AddressInfo;
    // как сервисы: ключи — по JWKS из auth
    verifier = new JwtVerifier({ jwksUrl: `http://localhost:${port}/.well-known/jwks.json` });
  });

  afterAll(() => app?.close());

  const api = () => request(app.getHttpServer());

  async function account() {
    const email = `user-${newId()}@marketplace.test`;
    const password = 'password-1';
    const res = await api().post('/auth/register').send({ email, password });
    expect(res.status).toBe(201);
    return { email, password, userId: res.body.userId as string };
  }

  async function login(credentials: { email: string; password: string }) {
    const res = await api().post('/auth/login').send(credentials);
    expect(res.status).toBe(200);
    return res.body as { accessToken: string; refreshToken: string };
  }

  const refresh = (refreshToken: string) => api().post('/auth/refresh').send({ refreshToken });

  /** Событие catalog, как его опубликует catalog: через outbox в `catalog.events`. */
  const emit = <D extends AnyMessageDefinition>(
    definition: D,
    payload: PayloadOf<D>,
    version: number,
  ) =>
    runInNewChain(() =>
      prisma.$transaction((tx) =>
        outbox.add(tx, definition, payload, {
          aggregateId: definition.key(payload),
          aggregateVersion: version,
        }),
      ),
    );

  it('регистрация: user.registered в outbox; повтор email в другом регистре — 409', async () => {
    const { email, userId } = await account();
    const row = await prisma.outbox.findFirst({ where: { messageKey: userId } });
    expect((row?.payload as { type: string }).type).toBe('user.registered');
    const again = await api()
      .post('/auth/register')
      .send({ email: email.toUpperCase(), password: 'password-2' });
    expect(again.status).toBe(409);
  });

  it('вход: токен проверяется по JWKS; неверный пароль и неизвестный email — одинаковый 401', async () => {
    const user = await account();
    const { accessToken } = await login(user);
    expect(await verifier.verify(accessToken)).toEqual({
      sub: user.userId,
      roles: ['buyer'],
      scopes: [],
    });
    const wrong = await api()
      .post('/auth/login')
      .send({ ...user, password: 'wrong-pass' });
    const unknown = await api()
      .post('/auth/login')
      .send({ email: 'ghost@marketplace.test', password: 'wrong-pass' });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('пароль хранится как argon2id', async () => {
    const { userId } = await account();
    const user = await prisma.user.findUniqueOrThrow({ where: { userId } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('повтор использованного refresh отзывает семейство: оба токена дают 401', async () => {
    const pair = await login(await account());
    const rotated = await refresh(pair.refreshToken);
    expect(rotated.status).toBe(200);
    expect((await refresh(pair.refreshToken)).status).toBe(401);
    expect((await refresh(rotated.body.refreshToken)).status).toBe(401);
  });

  it('одновременные обновления одним refresh — проходит одно', async () => {
    const pair = await login(await account());
    const results = await Promise.all([refresh(pair.refreshToken), refresh(pair.refreshToken)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('выход отзывает семейство', async () => {
    const pair = await login(await account());
    expect(
      (await api().post('/auth/logout').send({ refreshToken: pair.refreshToken })).status,
    ).toBe(204);
    expect((await refresh(pair.refreshToken)).status).toBe(401);
  });

  it('seller.* из Kafka: pending и active — кабинет в токене, blocked — нет', async () => {
    const owner = await account();
    const sellerId = newId();
    const claimsAfterRefresh = async (refreshToken: string) => {
      const res = await refresh(refreshToken);
      expect(res.status).toBe(200);
      return {
        claims: await verifier.verify(res.body.accessToken),
        refreshToken: res.body.refreshToken as string,
      };
    };
    let { refreshToken } = await login(owner);

    await emit(SellerRegisteredV1, { sellerId, ownerUserId: owner.userId, name: 'Магазин' }, 1);
    await eventually(async () => (await prisma.membership.count({ where: { sellerId } })) === 1, {
      what: 'членство владельца',
    });
    let claims: Claims;
    ({ claims, refreshToken } = await claimsAfterRefresh(refreshToken));
    expect(claims).toMatchObject({ roles: ['buyer', 'seller'], sellerId });

    await emit(SellerApprovedV1, { sellerId }, 2);
    await eventually(
      async () =>
        (await prisma.membership.findUnique({ where: { userId: owner.userId } }))?.sellerStatus ===
        'active',
      { what: 'магазин одобрен' },
    );

    await emit(SellerBlockedV1, { sellerId, reason: 'жалобы' }, 3);
    await eventually(
      async () =>
        (await prisma.membership.findUnique({ where: { userId: owner.userId } }))?.sellerStatus ===
        'blocked',
      { what: 'магазин заблокирован' },
    );
    ({ claims } = await claimsAfterRefresh(refreshToken));
    expect(claims).toEqual({ sub: owner.userId, roles: ['buyer'], scopes: [] });
  });

  it('сотрудники: владелец добавляет по email, права в токене сотрудника; не владельцу — 403', async () => {
    const owner = await account();
    const clerk = await account();
    const sellerId = newId();
    await emit(SellerRegisteredV1, { sellerId, ownerUserId: owner.userId, name: 'Магазин' }, 1);
    await eventually(async () => (await prisma.membership.count({ where: { sellerId } })) === 1, {
      what: 'членство владельца',
    });
    const ownerToken = (await login(owner)).accessToken;
    const hired = await api()
      .post('/seller/staff')
      .auth(ownerToken, { type: 'bearer' })
      .send({ email: clerk.email, scopes: ['catalog'] });
    expect(hired.status).toBe(201);

    const clerkToken = (await login(clerk)).accessToken;
    expect(await verifier.verify(clerkToken)).toMatchObject({
      roles: ['buyer', 'seller_manager'],
      sellerId,
      scopes: ['catalog'],
    });
    const forbidden = await api().get('/seller/staff').auth(clerkToken, { type: 'bearer' });
    expect(forbidden.status).toBe(403);
    const list = await api().get('/seller/staff').auth(ownerToken, { type: 'bearer' });
    expect(list.body.map((m: { email: string }) => m.email).sort()).toEqual(
      [owner.email, clerk.email].sort(),
    );
  });

  it('каждый эндпоинт кабинета: без прав магазина — 403', async () => {
    const buyer = (await login(await account())).accessToken;
    const endpoints = sellerEndpoints(app);
    expect(endpoints.length).toBeGreaterThan(0);
    for (const { method, path } of endpoints) {
      const url = path.replace(/:[a-zA-Z]+/g, newId());
      const res = await api()
        [method.toLowerCase() as 'get']('' + url)
        .auth(buyer, { type: 'bearer' })
        .send({});
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
    }
  });

  it('/auth/me — роли по базе; без токена — 401', async () => {
    const user = await account();
    const { accessToken } = await login(user);
    const me = await api().get('/auth/me').auth(accessToken, { type: 'bearer' });
    expect(me.body).toEqual({
      userId: user.userId,
      email: user.email,
      roles: ['buyer'],
      seller: null,
    });
    expect((await api().get('/auth/me')).status).toBe(401);
  });

  it('первый админ из env: вход даёт роль admin', async () => {
    const { accessToken } = await login(ADMIN);
    expect((await verifier.verify(accessToken)).roles).toEqual(['buyer', 'admin']);
  });

  it('ключ подписи в базе: второй экземпляр подписывает тем же ключом', async () => {
    const second = await start();
    try {
      expect(second.get(SigningKeys).jwks()).toEqual(app.get(SigningKeys).jwks());
      expect(await prisma.signingKey.count({ where: { active: true } })).toBe(1);
    } finally {
      await second.close();
    }
  });

  it('seed тестовых пользователей: вход по общему паролю, повтор ничего не меняет', async () => {
    const hasher = new Argon2Hasher();
    const client = prisma as unknown as PrismaClient;
    await seedDevUsers(client, 'dev-password-1', hasher);
    expect(await seedDevUsers(client, 'dev-password-1', hasher)).toBe(0);
    const admin = dev('admin');
    const { accessToken } = await login({ email: admin.email, password: 'dev-password-1' });
    expect(await verifier.verify(accessToken)).toMatchObject({
      sub: admin.userId,
      roles: ['buyer', 'admin'],
    });
    const manager = dev('manager-a');
    expect(await prisma.membership.findUnique({ where: { userId: manager.userId } })).toMatchObject(
      { role: 'seller_manager', scopes: ['orders'] },
    );
    // user.registered — по одному на пользователя, повтор seed событий не добавил
    const events = await prisma.outbox.findMany({ where: { messageKey: admin.userId } });
    expect(events.map((e) => (e.payload as { type: string }).type)).toEqual(['user.registered']);
  });
});
