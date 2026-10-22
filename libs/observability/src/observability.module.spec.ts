import { Controller, Get, Injectable, Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger as PinoNestLogger } from 'nestjs-pino';
import request from 'supertest';
import { requireContext } from './context';
import { READINESS_TIMEOUT_MS, type ReadinessCheck } from './health';
import { ObservabilityModule } from './observability.module';

type LogLine = Record<string, unknown>;

@Controller('things')
class ThingsController {
  private readonly logger = new Logger(ThingsController.name);

  @Get()
  async list() {
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.logger.log('listing things');
    return { correlationId: requireContext().correlationId };
  }
}

const state = { database: 'up' as 'up' | 'down' | 'hang' };

@Injectable()
class DatabaseCheck implements ReadinessCheck {
  readonly name = 'database';
  async check(): Promise<void> {
    if (state.database === 'down') throw new Error('connection refused');
    if (state.database === 'hang') await new Promise(() => undefined);
  }
}

@Injectable()
class KafkaCheck implements ReadinessCheck {
  readonly name = 'kafka';
  async check(): Promise<void> {
    return undefined;
  }
}

describe('ObservabilityModule', () => {
  let app: INestApplication;
  const logs: LogLine[] = [];
  const destination = { write: (line: string) => void logs.push(JSON.parse(line)) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ObservabilityModule.forRoot({
          serviceName: 'demo',
          destination,
          readinessChecks: [DatabaseCheck, KafkaCheck],
        }),
      ],
      controllers: [ThingsController],
    }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(PinoNestLogger));
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    logs.length = 0;
    state.database = 'up';
  });

  const linesFor = (correlationId: string) => logs.filter((l) => l.correlationId === correlationId);

  describe('correlationId', () => {
    it('берёт X-Request-Id от gateway и возвращает его в ответе', async () => {
      const res = await request(app.getHttpServer()).get('/things').set('X-Request-Id', 'gw-123');
      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe('gw-123');
      expect(res.body).toEqual({ correlationId: 'gw-123' });
    });

    it('создаёт новый, если заголовка нет', async () => {
      const res = await request(app.getHttpServer()).get('/things');
      expect(res.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers['x-request-id']).toBe(res.body.correlationId);
    });

    it('заменяет небезопасный заголовок новым id', async () => {
      const res = await request(app.getHttpServer())
        .get('/things')
        .set('X-Request-Id', 'bad id\twith "quotes"');
      expect(res.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('логи', () => {
    it('лог приложения и лог запроса несут service и correlationId', async () => {
      await request(app.getHttpServer()).get('/things').set('X-Request-Id', 'gw-logs');
      const lines = linesFor('gw-logs');
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ msg: 'listing things', service: 'demo' }),
          expect.objectContaining({ msg: 'request completed', service: 'demo' }),
        ]),
      );
    });

    it('health-пробы не пишутся в лог', async () => {
      await request(app.getHttpServer()).get('/health/live');
      await request(app.getHttpServer()).get('/health/ready');
      expect(logs.filter((l) => l.msg === 'request completed')).toEqual([]);
    });
  });

  describe('health', () => {
    it('/health/live — 200 без проверки зависимостей', async () => {
      state.database = 'down';
      const res = await request(app.getHttpServer()).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('/health/ready — 200, когда все зависимости отвечают', async () => {
      const res = await request(app.getHttpServer()).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.info).toEqual({ database: { status: 'up' }, kafka: { status: 'up' } });
    });

    it('/health/ready — 503 и причина, если зависимость упала', async () => {
      state.database = 'down';
      const res = await request(app.getHttpServer()).get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.error).toEqual({
        database: { status: 'down', message: 'connection refused' },
      });
      expect(res.body.info).toEqual({ kafka: { status: 'up' } });
    });

    it(
      '/health/ready — 503 по таймауту, если зависимость зависла',
      async () => {
        state.database = 'hang';
        const res = await request(app.getHttpServer()).get('/health/ready');
        expect(res.status).toBe(503);
        expect(res.body.error.database.message).toMatch(/нет ответа/);
      },
      READINESS_TIMEOUT_MS + 3_000,
    );
  });
});
