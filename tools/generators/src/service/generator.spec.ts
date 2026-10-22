import { readJson, type Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import serviceGenerator, {
  INIT_MIGRATION,
  OUTBOX_DDL,
  PROCESSED_EVENTS_DDL,
  PRISMA_VERSION,
} from './generator';

const WORKSPACE = join(__dirname, '..', '..', '..', '..');

/** Файлы, которые генератор читает или дописывает, — настоящие, из репозитория. */
const REAL_FILES = [
  'package.json',
  'tsconfig.json',
  'compose.yaml',
  '.env.example',
  'infra/postgres/services.txt',
  'infra/kafka/topics.conf',
  'libs/contracts/package.json',
  'libs/observability/package.json',
  OUTBOX_DDL,
  PROCESSED_EVENTS_DDL,
];

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  for (const file of REAL_FILES) tree.write(file, readFileSync(join(WORKSPACE, file)));
  return tree;
}

const read = (tree: Tree, path: string) => tree.read(path, 'utf-8') ?? '';

describe('генератор сервиса', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = workspace();
  });

  it('создаёт сервис полной схемы со всеми частями шаблона (SD-01, п. 7)', async () => {
    await serviceGenerator(tree, { name: 'demo' });
    for (const file of [
      'package.json',
      'Dockerfile',
      'prisma/schema.prisma',
      'prisma.config.ts',
      'prisma/migrations/migration_lock.toml',
      'src/instrumentation.ts',
      'src/main.ts',
      'src/app.module.ts',
      'src/config.ts',
      'src/config.spec.ts',
      'src/messaging.int-spec.ts',
      'src/infrastructure/prisma.service.ts',
      'src/infrastructure/messaging.ts',
      'src/testing/global-setup.cjs',
      'src/domain/.gitkeep',
      'src/application/.gitkeep',
      'src/interface/.gitkeep',
    ]) {
      expect(tree.exists(`apps/demo/${file}`)).toBe(true);
    }
    expect(tree.exists('apps/demo/src/handlers')).toBe(false);
  });

  it('тонкая схема: handlers, repositories, api', async () => {
    await serviceGenerator(tree, { name: 'notification', thin: true });
    expect(tree.exists('apps/notification/src/handlers/.gitkeep')).toBe(true);
    expect(tree.exists('apps/notification/src/domain')).toBe(false);
  });

  it('подставляет имя и версии из libs', async () => {
    await serviceGenerator(tree, { name: 'demo' });
    const pkg = readJson(tree, 'apps/demo/package.json');
    const observability = readJson(tree, 'libs/observability/package.json');
    expect(pkg.name).toBe('@repo/demo');
    expect(pkg.nx.tags).toEqual(['type:app', 'platform:node']);
    expect(pkg.dependencies['@nestjs/core']).toBe(observability.dependencies['@nestjs/core']);
    expect(pkg.dependencies['@prisma/client']).toBe(PRISMA_VERSION);
    expect(read(tree, 'apps/demo/src/instrumentation.ts')).toContain("initTelemetry('demo')");
    expect(read(tree, 'apps/demo/Dockerfile')).toContain('pnpm@12.14.0');
    expect(read(tree, 'apps/demo/Dockerfile')).not.toContain('<%');
  });

  it('первая миграция — точная копия DDL из libs', async () => {
    await serviceGenerator(tree, { name: 'demo' });
    const migration = read(tree, INIT_MIGRATION('demo'));
    expect(migration).toContain(read(tree, OUTBOX_DDL));
    expect(migration).toContain(read(tree, PROCESSED_EVENTS_DDL));
  });

  it('дописывает базу, топик DLQ, пароль и ссылку в tsconfig', async () => {
    await serviceGenerator(tree, { name: 'demo' });
    expect(read(tree, 'infra/postgres/services.txt').split('\n')).toContain('demo');
    expect(read(tree, 'infra/kafka/topics.conf')).toMatch(/^demo-service\.dlq\s+1\s+-1$/m);
    expect(read(tree, '.env.example')).toMatch(/^DEMO_DB_PASSWORD=demo_local$/m);
    expect(readJson(tree, 'tsconfig.json').references).toContainEqual({ path: './apps/demo' });
  });

  it('добавляет в compose шаг миграций и сервис, сохраняя инфраструктуру', async () => {
    await serviceGenerator(tree, { name: 'demo' });
    const compose = parse(read(tree, 'compose.yaml'));
    expect(Object.keys(compose.services)).toEqual(
      expect.arrayContaining(['postgres', 'kafka', 'demo-migrate', 'demo']),
    );
    expect(compose.services.demo.ports).toEqual(['3001:3000']);
    expect(compose.services.demo.environment.DATABASE_URL).toBe(
      'postgresql://demo_svc:${DEMO_DB_PASSWORD}@postgres:5432/demo_db',
    );
    expect(compose.services.demo.depends_on['demo-migrate']).toEqual({
      condition: 'service_completed_successfully',
    });
    expect(compose.services['demo-migrate'].build.target).toBe('migrate');
    // комментарии инфраструктуры не теряются
    expect(read(tree, 'compose.yaml')).toContain('бюджет — ADR-0004');
  });

  it('второму сервису достаётся следующий порт', async () => {
    await serviceGenerator(tree, { name: 'demo' });
    await serviceGenerator(tree, { name: 'other' });
    expect(parse(read(tree, 'compose.yaml')).services.other.ports).toEqual(['3002:3000']);
  });

  it('сервис из уже известного списка не дублирует строки', async () => {
    await serviceGenerator(tree, { name: 'order' });
    const services = read(tree, 'infra/postgres/services.txt').split('\n');
    expect(services.filter((l) => l === 'order')).toHaveLength(1);
    expect(read(tree, '.env.example').match(/^ORDER_DB_PASSWORD=/gm)).toHaveLength(1);
  });

  it('отклоняет недопустимое имя и существующий сервис', async () => {
    await expect(serviceGenerator(tree, { name: 'Bad-Name' })).rejects.toThrow(/не подходит/);
    await serviceGenerator(tree, { name: 'demo' });
    await expect(serviceGenerator(tree, { name: 'demo' })).rejects.toThrow(/уже существует/);
  });
});
