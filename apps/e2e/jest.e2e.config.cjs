// Сквозные сценарии SD-02, п. 1 против поднятого compose-стенда. Запуск — apps/e2e/run.sh.
// Не `jest.config.cjs`: обычный таргет test не должен их подхватывать.
module.exports = {
  displayName: '@repo/e2e',
  preset: '../../jest.preset.js',
  testMatch: ['<rootDir>/src/**/*.e2e-spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 240_000,
  maxWorkers: 1, // сценарии останавливают сервисы стенда: по одному
};
