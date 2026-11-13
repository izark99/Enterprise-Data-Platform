// Lint rules, including the layer matrix of docs/redesign/02-target-architecture.md §3.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SRC = 'apps/web/src';
// Top-level feature folders of 02 §2. A new feature folder must be added here to get its zone.
const FEATURES = ['auth', 'runner', 'designer', 'admin'];
// Imports are relative (07 §2), so a zone is matched on the import string. The number of `../`
// that reaches `src/` depends on how deep the importing file is; each zone is generated per depth.
const MAX_DEPTH = 10;
const ENGINE_PUBLIC = '(protocol|formula/public)(\\.ts)?$';

const up = (n) => `^(\\.\\./){${n}}`;
const layer = (d, names, message, extra = {}) => ({
  regex: `${up(d)}(${names})(/|$)`,
  message,
  ...extra,
});
const engineInternals = (d) => ({
  regex: `${up(d)}engine(/(?!${ENGINE_PUBLIC}).*)?$`,
  message: 'Outside src/engine import only engine/protocol and engine/formula/public (02 §3).',
});
const outsideSrc = (d) => ({
  regex: `${up(d + 1)}`,
  message: 'Do not import outside src/ by path; use the package name.',
});

const REACT = ['react', 'react-dom', 'react/*', 'react-dom/*', 'react-i18next'];
const SUPABASE = {
  group: ['@supabase/*'],
  message: 'Only src/api and src/app/services.ts talk to Supabase (02 §3).',
};

// Forbidden import patterns of each layer for a file `d` directories below src/.
const ZONES = {
  app: (d, { supabase = true } = {}) => [
    outsideSrc(d),
    engineInternals(d),
    ...(supabase ? [SUPABASE] : []),
  ],
  shared: (d) => [
    outsideSrc(d),
    layer(
      d,
      'app|features',
      'shared may import only shared, api, ui and the engine public surface (02 §3).',
    ),
    engineInternals(d),
    SUPABASE,
  ],
  api: (d) => [
    outsideSrc(d),
    layer(
      d,
      'app|features|shared|ui',
      'api may import only api, flow-schema and engine types (02 §3).',
    ),
    {
      regex: `${up(d)}engine/${ENGINE_PUBLIC}`,
      message: 'api may import only types from the engine public surface (02 §3).',
      allowTypeImports: true,
    },
    engineInternals(d),
  ],
  ui: (d) => [
    outsideSrc(d),
    layer(d, 'app|features|shared|api|engine', 'ui stands alone: it imports only ui (02 §3).'),
    {
      group: ['@hrflow/flow-schema', '@tanstack/react-router', 'i18next', '@supabase/*'],
      message: 'ui has no app knowledge: no schema, router, i18n instance or Supabase (02 §3).',
    },
  ],
  engine: (d) => [
    outsideSrc(d),
    layer(
      d,
      'app|features|shared|api|ui',
      'engine stands alone: it imports only engine and flow-schema (02 §3).',
    ),
    { group: REACT, message: 'No React inside src/engine (02 §2).' },
    SUPABASE,
  ],
  feature: (d, own) => [
    outsideSrc(d),
    layer(d, 'app', 'A feature may not import app (02 §3).'),
    {
      regex: `${up(d - 1)}(?!${own}(/|$))[^./][^/]*(/|$)`,
      message: 'No feature imports another feature; move shared code to src/shared (02 §3).',
    },
    engineInternals(d),
    SUPABASE,
  ],
};

const globsAt = (base, depth) => [`${base}/${'*/'.repeat(depth)}*.{ts,tsx}`];
const zone = (files, patterns) => ({
  files,
  rules: { 'no-restricted-imports': ['error', { patterns }] },
});

const layerZones = [
  // src/main.tsx is the composition root: same rules as app.
  zone(globsAt(SRC, 0), ZONES.app(0)),
  ...['app', 'shared', 'api', 'ui', 'engine'].flatMap((name) =>
    Array.from({ length: MAX_DEPTH }, (_, i) =>
      zone(globsAt(`${SRC}/${name}`, i), ZONES[name](i + 1)),
    ),
  ),
  ...FEATURES.flatMap((own) =>
    Array.from({ length: MAX_DEPTH - 1 }, (_, i) =>
      zone(globsAt(`${SRC}/features/${own}`, i), ZONES.feature(i + 2, own)),
    ),
  ),
  // 02 §3: services.ts wires the Supabase client.
  zone([`${SRC}/app/services.ts`], ZONES.app(1, { supabase: false })),
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'fixtures/**',
      'vendor/**',
      'docs/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportDefaultDeclaration', message: 'Use named exports (07 §3).' },
        {
          selector: 'ExportNamedDeclaration > ExportSpecifier[exported.name="default"]',
          message: 'Use named exports (07 §3).',
        },
      ],
    },
  },
  {
    files: [`${SRC}/**/*.tsx`],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: [`${SRC}/engine/**`],
    languageOptions: { globals: { ...globals.worker } },
    rules: { 'no-console': 'error' },
  },
  // Tool config files must use a default export.
  {
    files: ['*.config.{js,ts}', 'apps/*/*.config.{js,ts}', 'packages/*/*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-syntax': 'off' },
  },
  ...layerZones,
  prettier,
);
