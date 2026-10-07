// Minimal lint: branching and loops only in block form (no ternaries,
// no braceless single-line statements). Formatting stays with Prettier.
import eslintConfigPrettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['.output/**', '.wxt/**', 'dist/**', 'node_modules/**'],
  },
  // Prettier first: it only switches off formatting rules.
  // Our style rules below take precedence (curly:"all" never conflicts
  // with Prettier — braces are always present by then).
  eslintConfigPrettier,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      curly: ['error', 'all'],
      'no-ternary': 'error',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    rules: {
      curly: ['error', 'all'],
      'no-ternary': 'error',
    },
  },
)
