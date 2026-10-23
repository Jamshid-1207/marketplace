// Интеграционные тесты на Testcontainers: Postgres с миграциями сервиса и Kafka. Нужен Docker.
module.exports = {
  displayName: '@repo/catalog:int',
  preset: '../../jest.preset.js',
  testMatch: ['<rootDir>/src/**/*.int-spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  globalSetup: '<rootDir>/src/testing/global-setup.cjs',
  globalTeardown: '<rootDir>/src/testing/global-teardown.cjs',
  testTimeout: 120_000,
  maxWorkers: 1, // контейнеры общие на прогон
};
