import { defineConfig, devices } from '@playwright/test';

/**
 * Сценарии витрины в браузере (SD-07, п. 1, решение 11): на том же compose-стенде, после
 * Jest-сценариев, только Chromium. Запуск — apps/e2e/run.sh.
 */
export default defineConfig({
  testDir: './src/ui',
  testMatch: '**/*.ui-spec.ts',
  outputDir: './test-output/playwright',
  // сценарии меняют общий стенд: по одному, как Jest-сценарии
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './test-output/playwright-report' }],
  ],
  use: {
    baseURL: process.env.E2E_STOREFRONT_URL ?? 'http://localhost:3001',
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
