// Bundle budget of 02-target-architecture.md §7, run after `vite build`.
// Start-up JS = the entry script + the modulepreload chunks referenced by dist/index.html,
// each gzipped at level 9. `--measure` prints the numbers and never fails.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(appDir, 'dist');
const measureOnly = process.argv.includes('--measure');
const budget = JSON.parse(readFileSync(join(appDir, 'bundle-budget.json'), 'utf8'));

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const gzipSize = (buffer) => gzipSync(buffer, { level: 9 }).length;

const html = readFileSync(join(distDir, 'index.html'), 'utf8');
const startupFiles = new Set();
for (const tag of html.match(/<(script|link)\b[^>]*>/g) ?? []) {
  const isEntry = /^<script\b/.test(tag) && /\btype="module"/.test(tag);
  const isPreload = /^<link\b/.test(tag) && /\brel="modulepreload"/.test(tag);
  const url = tag.match(/\b(?:src|href)="([^"]+)"/)?.[1];
  if ((isEntry || isPreload) && url !== undefined && !/^[a-z]+:/i.test(url)) {
    startupFiles.add(url.replace(/^\//, ''));
  }
}
if (startupFiles.size === 0) {
  console.error('bundle-budget: FAIL no entry script found in dist/index.html');
  process.exit(1);
}

const startup = [...startupFiles].map((file) => readFileSync(join(distDir, file)));
const startupGzip = startup.reduce((sum, buffer) => sum + gzipSize(buffer), 0);
const startupText = startup.map((buffer) => buffer.toString('utf8')).join('\n');

const failures = [];
const limit = budget.startupJsLimitGzipBytes;
if (startupGzip > limit) {
  failures.push(`start-up JS ${kib(startupGzip)} gzip exceeds ${kib(limit)}`);
}

const libraryLines = budget.notInStartupJs.map(({ library, package: pkg, marker }) => {
  if (!existsSync(join(appDir, 'node_modules', pkg, 'package.json'))) {
    return `  ${library}: not present (${pkg} not installed)`;
  }
  if (startupText.includes(marker)) {
    failures.push(`${library} is in the start-up JS (marker "${marker}")`);
    return `  ${library}: IN START-UP JS`;
  }
  return `  ${library}: not in start-up JS`;
});

const assetsDir = join(distDir, 'assets');
const cssFiles = readdirSync(assetsDir).filter((file) => file.endsWith('.css'));
const cssGzip = cssFiles.reduce(
  (sum, file) => sum + gzipSize(readFileSync(join(assetsDir, file))),
  0,
);

const summary = `start-up JS ${kib(startupGzip)} gzip in ${startupFiles.size} file(s) (limit ${kib(limit)}, zlib level 9); CSS ${kib(cssGzip)} gzip in ${cssFiles.length} file(s)`;
if (failures.length > 0 && !measureOnly) {
  console.error(`bundle-budget: FAIL ${summary}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(libraryLines.join('\n'));
  process.exit(1);
}
console.log(`bundle-budget: ${measureOnly ? 'MEASURE' : 'OK'} ${summary}`);
console.log(libraryLines.join('\n'));
for (const failure of failures) console.log(`  - would fail: ${failure}`);
