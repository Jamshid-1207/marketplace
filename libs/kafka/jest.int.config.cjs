// Интеграционные тесты на Testcontainers: настоящие Postgres и Kafka (SD-01, п. 8). Нужен Docker.
module.exports = {
  displayName: '@repo/kafka:int',
  preset: '../../jest.preset.js',
  testMatch: ['<rootDir>/src/**/*.int-spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  globalSetup: '<rootDir>/src/testing/global-setup.cjs',
  globalTeardown: '<rootDir>/src/testing/global-teardown.cjs',
  testTimeout: 120_000,
  maxWorkers: 1, // контейнеры общие на прогон
};
