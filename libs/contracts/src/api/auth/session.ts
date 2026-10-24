import { z } from 'zod';

/** `POST /auth/register` (SD-05, п. 5.3). */
export const RegisterRequest = z.object({
  email: z.email().max(254),
  // argon2 не ограничивает длину, но ограничение защищает от дорогих хешей огромных строк
  password: z.string().min(8).max(128),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const RegisterResponse = z.object({ userId: z.uuid() });
export type RegisterResponse = z.infer<typeof RegisterResponse>;

/** `POST /auth/login`: политика паролей не проверяется, иначе ответ отличался бы от неверного пароля. */
export const LoginRequest = z.object({
  email: z.string().max(254),
  password: z.string().max(128),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** `POST /auth/refresh` и `POST /auth/logout`. */
export const RefreshRequest = z.object({ refreshToken: z.string().min(1).max(200) });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const TokenPair = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Секунд до истечения access-токена. */
  expiresIn: z.number().int().positive(),
});
export type TokenPair = z.infer<typeof TokenPair>;

/** `GET /auth/me`: роли и членство — по базе, а не по токену, который может отставать до 15 минут. */
export const MeResponse = z.object({
  userId: z.uuid(),
  email: z.string(),
  roles: z.array(z.string()),
  seller: z
    .object({
      sellerId: z.uuid(),
      role: z.string(),
      scopes: z.array(z.string()),
      status: z.string(),
    })
    .nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;
