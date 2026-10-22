import { defineConfig } from 'prisma/config';

// Строка подключения — только из env (ADR-0004, п. 7). Для prisma generate она не нужна.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
