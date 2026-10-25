module.exports = {
  displayName: '@repo/backoffice',
  preset: '../../jest.preset.js',
  coverageDirectory: 'test-output/jest/coverage',
  // тексты интерфейса — JSON: тест проверяет, что у каждого раздела есть перевод
  moduleFileExtensions: ['ts', 'js', 'json'],
  // server-only бросает ошибку вне React Server Components; в unit-тестах это обычный модуль
  moduleNameMapper: { '^server-only$': '<rootDir>/src/testing/server-only.ts' },
};
