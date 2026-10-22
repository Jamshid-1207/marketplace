import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { messages } from './messages';

/**
 * Контракт-тесты (ADR-0003, п. 5): на каждую версию каждого сообщения есть JSON-фикстура,
 * она проходит свою схему и приводится upcaster'ами к последней версии.
 * Удалить старую версию, пока лежит её фикстура, или забыть upcaster не получится.
 */
const FIXTURES = join(__dirname, '..', 'fixtures');
const fixtureName = (type: string, version: number) => `${type}.v${version}.json`;
const readFixture = (file: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));

describe('контракты сообщений', () => {
  it('реестр целостен: версии без пропусков, upcaster на каждую старую версию', () => {
    expect(() => messages.verify()).not.toThrow();
  });

  const definitions = messages.definitions();
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));

  it.each(definitions.map((d) => [fixtureName(d.type, d.version), d] as const))(
    '%s проходит схему и приводится к последней версии',
    (file, definition) => {
      expect(files).toContain(file);
      const result = messages.decode(readFixture(file));
      expect(result.status).toBe('decoded');
      if (result.status !== 'decoded') return;
      expect(result.definition).toBe(messages.latest(definition.type));
    },
  );

  it('нет фикстур без определения', () => {
    const known = new Set(definitions.map((d) => fixtureName(d.type, d.version)));
    expect(files.filter((f) => !known.has(f))).toEqual([]);
  });
});
