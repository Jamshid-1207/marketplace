import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/test-output', '**/src/generated'],
  },
  {
    files: ['**/*.ts', '**/*.js', '**/*.cjs', '**/*.mjs'],
    rules: {
      // Границы модулей: ADR-0003, п. 4
      '@nx/enforce-module-boundaries': [
        'error',
        {
          allow: ['^.*/eslint(\.base)?\.config\.[cm]?[jt]s$'],
          depConstraints: [
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:contracts', 'type:infra', 'type:ui'],
            },
            { sourceTag: 'type:infra', onlyDependOnLibsWithTags: ['type:contracts', 'type:infra'] },
            { sourceTag: 'type:ui', onlyDependOnLibsWithTags: ['type:contracts', 'type:ui'] },
            { sourceTag: 'type:contracts', onlyDependOnLibsWithTags: [] },
            { sourceTag: 'type:tooling', onlyDependOnLibsWithTags: [] },
            {
              sourceTag: 'platform:web',
              onlyDependOnLibsWithTags: ['platform:web', 'platform:shared'],
            },
            {
              sourceTag: 'platform:node',
              onlyDependOnLibsWithTags: ['platform:node', 'platform:shared'],
            },
          ],
        },
      ],
    },
  },
  {
    // слой domain без фреймворков и инфраструктуры (SD-00, п. 8)
    files: ['apps/*/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@nestjs/*',
            '@prisma/*',
            'kafkajs',
            '**/generated/**',
            '**/infrastructure/**',
            '**/interface/**',
          ],
        },
      ],
    },
  },
];
