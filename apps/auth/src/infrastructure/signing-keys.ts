import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { signAccessToken, TOKEN_ALGORITHM, type Claims } from '@repo/auth';
import { newId } from '@repo/contracts';
import { exportJWK, generateKeyPair, importJWK, type CryptoKey, type JWK } from 'jose';
import type { TokenSigner } from '../application/ports';
import { CONFIG, type Config } from '../config';
import { PrismaService } from './prisma.service';

interface ActiveKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

/**
 * Ключ подписи access-токенов (решение 1 SD-05): создаётся при первом старте и хранится в базе;
 * JWKS отдаёт его публичную часть. Ротация — после MVP.
 */
@Injectable()
export class SigningKeys implements TokenSigner, OnModuleInit {
  private key?: ActiveKey;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async onModuleInit(): Promise<void> {
    this.key = (await this.load()) ?? (await this.create());
  }

  /** Тело `/.well-known/jwks.json`. */
  jwks(): { keys: JWK[] } {
    return { keys: this.key ? [this.key.publicJwk] : [] };
  }

  sign(claims: Claims): Promise<string> {
    if (!this.key) throw new Error('ключ подписи ещё не загружен');
    return signAccessToken(
      this.key.privateKey,
      this.key.kid,
      claims,
      this.config.ACCESS_TOKEN_TTL_SECONDS,
    );
  }

  private async load(): Promise<ActiveKey | null> {
    const row = await this.prisma.signingKey.findFirst({ where: { active: true } });
    if (!row) return null;
    return {
      kid: row.kid,
      privateKey: (await importJWK(row.privateJwk as JWK, TOKEN_ALGORITHM)) as CryptoKey,
      publicJwk: row.publicJwk as JWK,
    };
  }

  private async create(): Promise<ActiveKey> {
    const { privateKey, publicKey } = await generateKeyPair(TOKEN_ALGORITHM, {
      crv: 'Ed25519',
      extractable: true,
    });
    const kid = newId();
    const meta = { kid, alg: TOKEN_ALGORITHM, use: 'sig' };
    const publicJwk = { ...(await exportJWK(publicKey)), ...meta };
    const privateJwk = { ...(await exportJWK(privateKey)), ...meta };
    // экземпляр, стартовавший одновременно, не вставит свой ключ и возьмёт ключ первого
    await this.prisma.$executeRaw`
      INSERT INTO signing_keys (kid, private_jwk, public_jwk, active)
      VALUES (${kid}, ${JSON.stringify(privateJwk)}::jsonb, ${JSON.stringify(publicJwk)}::jsonb, true)
      ON CONFLICT DO NOTHING`;
    const key = await this.load();
    if (!key) throw new Error('активный ключ подписи не создан');
    return key;
  }
}
