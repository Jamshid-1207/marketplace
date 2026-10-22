const nxPreset = require('@nx/jest/preset').default;

// Общий пресет: swc вместо ts-jest (SD-01, п. 8), исходники workspace-пакетов через условие @repo/source
module.exports = {
  ...nxPreset,
  testEnvironment: 'node',
  testEnvironmentOptions: {
    customExportConditions: ['@repo/source', 'node', 'require', 'default'],
  },
  transform: {
    '^.+\.[tj]s$': [
      '@swc/jest',
      {
        swcrc: false,
        jsc: {
          target: 'es2024',
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
        module: { type: 'commonjs' },
        sourceMaps: 'inline',
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js'],
};
