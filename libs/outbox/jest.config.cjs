module.exports = {
  displayName: '@repo/outbox',
  preset: '../../jest.preset.js',
  coverageDirectory: 'test-output/jest/coverage',
  collectCoverage: true,
  // порог — для чистой логики; PgRelayStore проверяют интеграционные тесты libs/kafka (SD-01, п. 8)
  collectCoverageFrom: ['src/relay.ts', 'src/outbox.ts'],
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
};
