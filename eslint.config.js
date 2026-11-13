// typescript-eslint strict, plus the design's money rules and its tokens: no parseFloat anywhere (money is parsed from strings
// into integer cents), and packages/domain stays pure (no I/O, no Node or Cloudflare APIs).
import tseslint from 'typescript-eslint';

/** A class with a typed-in style: text-[..], rounded-[..], shadow-[..], or any color in brackets (-[#..], -[rgb(..]). */
const TYPED_IN_STYLE = String.raw`\b(text|rounded|shadow)-\[|-\[(#|rgba?\(|hsla?\()`;

export default tseslint.config(
  {
    ignores: [
      '**/.bundle/**',
      '.claude/**',
      '**/.measure/**',
      '**/dist/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      'docs/**',
      '**/worker-configuration.d.ts',
      'e2e/screenshots/**',
      '**/playwright-report/**',
      '**/*.mjs',
      '**/*.config.ts',
    ],
  },
  ...tseslint.configs.strict,
  {
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is integer cents: use parseCents().' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: 'Money is integer cents: use parseCents().' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Design tokens only (docs/design-system.md): no typed-in color, text size, corner or shadow in a class name.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...['Literal[value=', 'TemplateElement[value.raw='].map((node) => ({
          selector: `${node}/${TYPED_IN_STYLE}/]`,
          message:
            'Use a design token (docs/design-system.md): no typed-in color, text size, corner or shadow.',
        })),
      ],
    },
  },
  {
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'node:*',
            'cloudflare:*',
            '@ledgerline/db',
            '@ledgerline/platform',
            '@ledgerline/bank-provider',
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is integer cents: use parseCents().' },
        { name: 'fetch', message: 'packages/domain has no I/O.' },
        { name: 'crypto', message: 'packages/domain has no I/O.' },
      ],
    },
  },
);
