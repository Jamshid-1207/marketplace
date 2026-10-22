// Типы пакет кладёт в register-hooks.d.ts, а для импорта `.mjs` TypeScript ищет `.d.mts`
declare module 'import-in-the-middle/register-hooks.mjs' {
  export function register(options?: {
    include?: Array<string | RegExp>;
    exclude?: Array<string | RegExp>;
  }): void;
  export function supportsSyncHooks(): boolean;
}
