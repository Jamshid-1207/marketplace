module.exports = {
  displayName: '@repo/web-session',
  preset: '../../jest.preset.js',
  coverageDirectory: 'test-output/jest/coverage',
  // server-only бросает ошибку вне React Server Components; в unit-тестах это обычный модуль
  moduleNameMapper: { '^server-only$': '<rootDir>/src/testing/server-only.ts' },
};
