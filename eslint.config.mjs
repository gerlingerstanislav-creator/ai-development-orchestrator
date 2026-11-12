import tseslint from 'typescript-eslint';

const typescriptFiles=[
 'apps/api/src/modules/**/*.ts',
 'apps/api/src/database/**/*.ts',
 'apps/web/src/features/**/*.{ts,tsx}',
 'apps/web/src/api/**/*.{ts,tsx}'
];

// Incremental gate: enforce strict conventions in extracted modules without
// mass-reformatting or rewriting legacy monoliths in the same PR.
export default [
 {
  files:typescriptFiles,
  languageOptions:{parser:tseslint.parser,parserOptions:{ecmaFeatures:{jsx:true}}},
  plugins:{'@typescript-eslint':tseslint.plugin},
  rules:{
   'no-constant-condition':'error',
   'no-unreachable':'error',
   'no-unsafe-optional-chaining':'error',
   '@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}]
  }
 },
 {
  files:['apps/codex-runner/command-executor.mjs','apps/codex-runner/codex-proxy.mjs'],
  rules:{'no-constant-condition':'error','no-unreachable':'error','no-unsafe-optional-chaining':'error'}
 }
];
