import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', '.sitepilot-data/**', 'docs/audit/**', 'coverage/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        setImmediate: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      // Existing Mastra/Prisma boundary code and test fakes still contain broad `any`s.
      // New context/memory modules use explicit types; migrate the legacy call sites separately.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // Control-character filters are deliberate input sanitizers in filename/query handling.
      'no-control-regex': 'off',
    },
  },
  {
    files: [
      'src/agent/conversation-context.ts',
      'src/agent/conversation-context.service.ts',
      'src/agent/user-memory.ts',
      'src/agent/user-memory.service.ts',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
);
