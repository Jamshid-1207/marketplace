module.exports = {
  displayName: '@repo/contracts',
  preset: '../../jest.preset.js',
  coverageDirectory: 'test-output/jest/coverage',
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/index.ts'],
  // страховка, а не цель (SD-01, п. 8)
  coverageThreshold: { global: { branches: 80, functions: 80, lines: 80, statements: 80 } },
};
