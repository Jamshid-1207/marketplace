import { Controller, Get, type INestApplication } from '@nestjs/common';
import { ObservabilityModule } from '@repo/observability';
import { Test } from '@nestjs/testing';
import { newId } from '@repo/contracts';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AuthModule } from './auth.module';
import { TOKEN_AUDIENCE, TOKEN_ISSUER, type AccessScope, type Claims } from './claims';
import { DevTokenIssuer } from './dev-issuer';
import { AdminScope, BuyerScope, CurrentClaims, Public } from './guard';
import { InvalidTokenError, JwtVerifier } from './verifier';

/** JWKS по HTTP, как его отдаёт gateway: проверяется настоящий путь через сеть. */
async function serveJwks(issuer: DevTokenIssuer): Promise<{ url: string; server: Server }> {
  const server = createServer((_, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(issuer.jwks()));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://localhost:${port}/.well-known/jwks.json`, server };
}

const buyer: Claims = { sub: newId(), roles: ['buyer'], scopes: [] };

describe('JwtVerifier', () => {
  let issuer: DevTokenIssuer;
  let server: Server;
  let verifier: JwtVerifier;

  beforeAll(async () => {
    issuer = await DevTokenIssuer.create();
    const jwks = await serveJwks(issuer);
    server = jwks.server;
    verifier = new JwtVerifier({ jwksUrl: jwks.url });
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('принимает токен заглушки и возвращает claims', async () => {
    const sellerId = newId();
    const claims: Claims = {
      sub: newId(),
      roles: ['buyer', 'seller'],
      sellerId,
      scopes: ['orders'],
    };
    await expect(verifier.verify(await issuer.issue(claims))).resolves.toEqual(claims);
  });

  it('отклоняет просроченный токен', async () => {
    const token = await issuer.issue(buyer, -10);
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('отклоняет токен, подписанный чужим ключом', async () => {
    const stranger = await DevTokenIssuer.create();
    await expect(verifier.verify(await stranger.issue(buyer))).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('отклоняет чужой issuer или audience, даже с верной подписью', async () => {
    // отдельный ключ и JWKS: так подпись заведомо верна, и отказ объясняется только claims
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA' };
    const own = createServer((_, res) => res.end(JSON.stringify({ keys: [jwk] })));
    await new Promise<void>((resolve) => own.listen(0, resolve));
    const ownVerifier = new JwtVerifier({
      jwksUrl: `http://localhost:${(own.address() as AddressInfo).port}/jwks`,
    });
    const sign = (iss: string, aud: string) =>
      new SignJWT({ roles: ['buyer'] })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
        .setSubject(newId())
        .setIssuer(iss)
        .setAudience(aud)
        .setExpirationTime('1m')
        .sign(privateKey);
    try {
      await expect(
        ownVerifier.verify(await sign(TOKEN_ISSUER, TOKEN_AUDIENCE)),
      ).resolves.toBeDefined();
      await expect(ownVerifier.verify(await sign('evil', TOKEN_AUDIENCE))).rejects.toThrow();
      await expect(ownVerifier.verify(await sign(TOKEN_ISSUER, 'other-api'))).rejects.toThrow();
    } finally {
      await new Promise((resolve) => own.close(resolve));
    }
  });

  it('отклоняет испорченный токен и не-JWT', async () => {
    const token = await issuer.issue(buyer);
    const [header, payload, signature] = token.split('.');
    const tampered = Buffer.from(
      JSON.stringify({ ...buyer, roles: ['admin'], iss: TOKEN_ISSUER }),
    ).toString('base64url');
    await expect(verifier.verify(`${header}.${tampered}.${signature}`)).rejects.toThrow();
    await expect(verifier.verify(`${header}.${payload}`)).rejects.toThrow();
    await expect(verifier.verify('nonsense')).rejects.toThrow();
  });

  it('локальный JWKS: тот же результат без сетевого запроса', async () => {
    const local = new JwtVerifier({ jwks: issuer.jwks() });
    expect(await local.verify(await issuer.issue(buyer))).toEqual(buyer);
    const other = await DevTokenIssuer.create();
    await expect(local.verify(await other.issue(buyer))).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('ключи из хранилища: новый ключ виден без пересоздания проверки', async () => {
    const other = await DevTokenIssuer.create();
    let current = issuer.jwks();
    const fromStore = new JwtVerifier({ keys: () => current });
    expect(await fromStore.verify(await issuer.issue(buyer))).toEqual(buyer);
    await expect(fromStore.verify(await other.issue(buyer))).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    current = other.jwks();
    expect(await fromStore.verify(await other.issue(buyer))).toEqual(buyer);
  });

  it('выпуск отклоняет claims, не соответствующие схеме', async () => {
    await expect(issuer.issue({ ...buyer, sub: 'not-a-uuid' })).rejects.toThrow();
  });
});

@Controller()
class ProbeController {
  @Get('me')
  me(@CurrentClaims() claims: Claims) {
    return claims;
  }

  @Get('my-orders')
  myOrders(@BuyerScope() scope: AccessScope) {
    return scope;
  }

  @Get('admin')
  admin(@AdminScope() scope: AccessScope) {
    return scope;
  }

  @Public()
  @Get('open')
  open() {
    return { ok: true };
  }
}

describe('AuthModule: guard и области доступа', () => {
  let app: INestApplication;
  let issuer: DevTokenIssuer;
  let server: Server;

  beforeAll(async () => {
    issuer = await DevTokenIssuer.create();
    const jwks = await serveJwks(issuer);
    server = jwks.server;
    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthModule.forRoot({ jwksUrl: jwks.url }),
        ObservabilityModule.forRoot({ serviceName: 'auth-test', level: 'fatal' }),
      ],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('без токена — 401, с испорченным — 401', async () => {
    expect((await get('/me')).status).toBe(401);
    expect((await get('/me', 'garbage')).status).toBe(401);
    expect(
      (await request(app.getHttpServer()).get('/me').set('Authorization', 'Basic x')).status,
    ).toBe(401);
  });

  it('@Public пропускает без токена', async () => {
    expect((await get('/open')).body).toEqual({ ok: true });
  });

  it('health-пробы открыты без токена', async () => {
    expect((await get('/health/live')).status).toBe(200);
    expect((await get('/health/ready')).status).toBe(200);
  });

  it('claims и область покупателя — только из проверенного токена', async () => {
    const token = await issuer.issue(buyer);
    expect((await get('/me', token)).body).toEqual(buyer);
    expect((await get('/my-orders', token)).body).toEqual({ kind: 'buyer', userId: buyer.sub });
  });

  it('область покупателя без роли buyer — 403', async () => {
    const admin = await issuer.issue({ sub: newId(), roles: ['admin'], scopes: [] });
    expect((await get('/my-orders', admin)).status).toBe(403);
  });

  it('область платформы — только у роли admin', async () => {
    const admin = await issuer.issue({ sub: newId(), roles: ['buyer', 'admin'], scopes: [] });
    expect((await get('/admin', admin)).body).toEqual({ kind: 'platform' });
    expect((await get('/admin', await issuer.issue(buyer))).status).toBe(403);
  });

  it('заголовки с идентичностью игнорируются', async () => {
    const res = await get('/my-orders').set('X-User-Id', buyer.sub);
    expect(res.status).toBe(401);
  });
});
