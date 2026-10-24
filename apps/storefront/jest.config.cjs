module.exports = {
  displayName: '@repo/storefront',
  preset: '../../jest.preset.js',
  coverageDirectory: 'test-output/jest/coverage',
  // тексты интерфейса — JSON: тест проверяет, что у каждого статуса есть перевод
  moduleFileExtensions: ['ts', 'js', 'json'],
  // server-only бросает ошибку вне React Server Components; в unit-тестах это обычный модуль
  moduleNameMapper: { '^server-only$': '<rootDir>/src/testing/server-only.ts' },
};
