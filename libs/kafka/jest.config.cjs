module.exports = {
  displayName: '@repo/kafka',
  preset: '../../jest.preset.js',
  coverageDirectory: 'test-output/jest/coverage',
  collectCoverage: true,
  // порог — для чистой логики; работу с брокером и reprocessDlq проверяют интеграционные тесты
  collectCoverageFrom: [
    'src/consumer-runner.ts',
    'src/dlq.ts',
    'src/errors.ts',
    'src/publisher.ts',
  ],
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
};
