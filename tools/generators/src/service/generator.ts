import {
  formatFiles,
  generateFiles,
  installPackagesTask,
  readJson,
  updateJson,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

export interface ServiceGeneratorSchema {
  name: string;
  thin?: boolean;
  /** Без базы и Kafka: gateway, заглушки внешних систем (SD-02, п. 8). */
  bare?: boolean;
  /** Порт хоста в compose. Без него сервис наружу не открыт (ADR-0001, п. 1). */
  port?: number;
}

/** Образ Node для Dockerfile: та же линия, что в `.nvmrc` и `engines`. */
export const NODE_IMAGE = 'node:24.11.1-alpine';
export const PRISMA_VERSION = '7.10.1';

// из имени сервиса с базой строятся база, роль и переменная окружения — дефис там не годится
const NAME_PATTERN = /^[a-z][a-z0-9]*$/;
const BARE_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** Порт `nx serve`, если порт хоста не задан. */
const DEFAULT_SERVE_PORT = 3100;

const DATA_LIBS = ['contracts', 'idempotency', 'kafka', 'observability', 'outbox', 'testing'];
const BARE_LIBS = ['contracts', 'observability'];

export const OUTBOX_DDL = 'libs/outbox/sql/outbox.sql';
export const PROCESSED_EVENTS_DDL = 'libs/idempotency/sql/processed_events.sql';
export const INIT_MIGRATION = (name: string) =>
  `apps/${name}/prisma/migrations/0_init/migration.sql`;

/**
 * Сервис по шаблону SD-01, п. 7. Сервис с базой дописывает ещё: базу в
 * `infra/postgres/services.txt`, топик DLQ в `infra/kafka/topics.conf`, пароль в `.env.example`
 * и шаг миграций в compose. Каждый сервис добавляется в корневой `compose.yaml`.
 */
export default async function serviceGenerator(
  tree: Tree,
  options: ServiceGeneratorSchema,
): Promise<GeneratorCallback> {
  const { name, bare = false } = options;
  if (!(bare ? BARE_NAME_PATTERN : NAME_PATTERN).test(name)) {
    throw new Error(
      bare
        ? `имя "${name}" не подходит: латиница в нижнем регистре, цифры и дефис между словами`
        : `имя "${name}" не подходит: латиница в нижнем регистре и цифры (из него строятся база и роль)`,
    );
  }
  const root = `apps/${name}`;
  if (tree.exists(root)) throw new Error(`${root} уже существует`);

  const substitutions = {
    name,
    bare,
    servePort: options.port ?? DEFAULT_SERVE_PORT,
    nodeImage: NODE_IMAGE,
    versions: readVersions(tree),
    libs: bare ? BARE_LIBS : DATA_LIBS,
    tmpl: '',
  };
  const files = (dir: string) =>
    generateFiles(tree, join(__dirname, 'files', dir), root, substitutions);
  files('common');

  if (!bare) {
    files('data');
    files(options.thin ? 'thin' : 'full');
    tree.write(`${root}/prisma/migrations/migration_lock.toml`, 'provider = "postgresql"\n');
    tree.write(INIT_MIGRATION(name), initMigration(tree));
    appendLineIfAbsent(tree, 'infra/postgres/services.txt', name);
    appendLineIfAbsent(
      tree,
      'infra/kafka/topics.conf',
      `${`${name}-service.dlq`.padEnd(30)}${'1'.padEnd(10)}-1`,
      (line) => line.startsWith(`${name}-service.dlq `),
    );
    addPassword(tree, name);
  }
  addComposeServices(tree, name, bare, options.port);
  updateJson(tree, 'tsconfig.json', (json) => {
    const path = `./${root}`;
    json.references ??= [];
    if (!json.references.some((r: { path: string }) => r.path === path)) {
      json.references.push({ path });
    }
    return json;
  });

  await formatFiles(tree);
  return () => installPackagesTask(tree);
}

/** Первая миграция — каноническая DDL из libs, без изменений (SD-01, п. 6). */
export function initMigration(tree: Tree): string {
  const read = (path: string) => {
    const content = tree.read(path, 'utf-8');
    if (content === null) throw new Error(`нет ${path}`);
    return content;
  };
  return [
    '-- Таблицы libs/outbox и libs/idempotency. Скопировано генератором; тест генератора сверяет копию.',
    read(OUTBOX_DDL),
    read(PROCESSED_EVENTS_DDL),
  ].join('\n');
}

/** Версии берутся из libs: сервис и libs не разъедутся по мажорам. */
function readVersions(tree: Tree) {
  const deps = (path: string) => readJson(tree, path).dependencies as Record<string, string>;
  const observability = deps('libs/observability/package.json');
  const root = readJson(tree, 'package.json');
  return {
    nest: observability['@nestjs/common'],
    nestjsPino: observability['nestjs-pino'],
    reflectMetadata: observability['reflect-metadata'],
    rxjs: observability.rxjs,
    zod: deps('libs/contracts/package.json').zod,
    prisma: PRISMA_VERSION,
    pnpm: (root.packageManager as string).replace(/^pnpm@/, ''),
  };
}

function appendLineIfAbsent(
  tree: Tree,
  path: string,
  line: string,
  exists: (line: string) => boolean = (l) => l.trim() === line,
): void {
  const content = tree.read(path, 'utf-8') ?? '';
  if (content.split('\n').some(exists)) return;
  tree.write(path, `${content.replace(/\n*$/, '\n')}${line}\n`);
}

/** Пароль роли сервиса — после последнего `*_DB_PASSWORD`. */
function addPassword(tree: Tree, name: string): void {
  const key = `${name.toUpperCase()}_DB_PASSWORD`;
  const lines = (tree.read('.env.example', 'utf-8') ?? '').split('\n');
  if (lines.some((l) => l.startsWith(`${key}=`))) return;
  const last = lines.map((l) => /^[A-Z0-9_]+_DB_PASSWORD=/.test(l)).lastIndexOf(true);
  lines.splice(last + 1, 0, `${key}=${name}_local`);
  tree.write('.env.example', lines.join('\n'));
}

/**
 * Сервис (и шаг миграций, если есть база) — прямо в корневой compose.yaml. Через `include` нельзя:
 * включённый файл Compose проверяет отдельно, и `depends_on` на инфраструктуру не разрешится.
 */
function addComposeServices(tree: Tree, name: string, bare: boolean, port?: number): void {
  const doc = parseDocument(tree.read('compose.yaml', 'utf-8') ?? '');
  const databaseUrl = `postgresql://${name}_svc:\${${name.toUpperCase()}_DB_PASSWORD}@postgres:5432/${name}_db`;
  const build = (target: string) => ({
    context: '.',
    dockerfile: `apps/${name}/Dockerfile`,
    target,
  });

  if (!bare) {
    doc.setIn(['services', `${name}-migrate`], {
      profiles: ['core', 'full'],
      build: build('migrate'),
      environment: { DATABASE_URL: databaseUrl },
      depends_on: { 'db-provision': { condition: 'service_completed_successfully' } },
    });
  }
  doc.setIn(['services', name], {
    profiles: ['core', 'full'],
    build: build('runtime'),
    restart: 'unless-stopped',
    environment: {
      PORT: '3000',
      ...(bare
        ? {}
        : { DATABASE_URL: databaseUrl, DB_POOL_MAX: '5', KAFKA_BROKERS: 'kafka:29092' }),
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://jaeger:4318',
    },
    ...(port === undefined ? {} : { ports: [`${port}:3000`] }),
    healthcheck: {
      test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/health/ready'],
      interval: '5s',
      timeout: '3s',
      retries: 30,
      start_period: '10s',
    },
    depends_on: {
      ...(bare
        ? {}
        : {
            [`${name}-migrate`]: { condition: 'service_completed_successfully' },
            'kafka-init': { condition: 'service_completed_successfully' },
            kafka: { condition: 'service_healthy' },
          }),
      jaeger: { condition: 'service_healthy' },
    },
    deploy: { resources: { limits: { memory: '256m' } } },
  });
  tree.write('compose.yaml', doc.toString({ lineWidth: 0 }));
}
