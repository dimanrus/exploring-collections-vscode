/**
 * Extracts every `vscode.l10n.t()` / `localize()` string from the sources and
 * regenerates the runtime localization bundles.
 *
 *   node scripts/generate-l10n.mjs           # generate + report missing keys
 *   node scripts/generate-l10n.mjs --check   # fail when a translation is missing
 *
 * English is the source of truth: the extracted strings are written to
 * `l10n/bundle.l10n.json`, translations live in `scripts/l10n.<locale>.json`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(root, 'src');
const L10N_DIR = join(root, 'l10n');
const TRANSLATION_DIR = join(root, 'scripts');

const PATTERNS = [
  /vscode\.l10n\.t\(\s*(['"])((?:\\.|(?!\1).)*)\1/g,
  /(?<![\w.])localize\(\s*'((?:[^'\\]|\\.)*)'/g,
  /(?<![\w.])t\(\s*'((?:[^'\\]|\\.)*)'/g
];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function unescape(value) {
  return value.replace(/\\(['"\\nrt])/g, (_match, character) => {
    switch (character) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return character;
    }
  });
}

const keys = new Map();
for (const file of walk(SOURCE_DIR)) {
  const content = readFileSync(file, 'utf8');
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const raw = match[2] ?? match[1];
      if (raw === undefined || raw.length === 0) {
        continue;
      }
      const key = unescape(raw);
      if (!keys.has(key)) {
        keys.set(key, file.slice(root.length + 1));
      }
    }
  }
}

mkdirSync(L10N_DIR, { recursive: true });

const identity = {};
for (const [key, source] of keys) {
  identity[key] = { message: key, comment: [source] };
}
writeFileSync(join(L10N_DIR, 'bundle.l10n.json'), `${JSON.stringify(identity, null, 2)}\n`, 'utf8');

const locales = ['ru'];
let missingTotal = 0;
for (const locale of locales) {
  const translationFile = join(TRANSLATION_DIR, `l10n.${locale}.json`);
  const translations = existsSync(translationFile)
    ? JSON.parse(readFileSync(translationFile, 'utf8'))
    : {};

  const bundle = {};
  const missing = [];
  for (const key of keys.keys()) {
    const translated = translations[key];
    if (typeof translated === 'string' && translated.length > 0) {
      bundle[key] = translated;
    } else {
      missing.push(key);
    }
  }

  writeFileSync(
    join(L10N_DIR, `bundle.l10n.${locale}.json`),
    `${JSON.stringify(bundle, null, 2)}\n`,
    'utf8'
  );

  if (missing.length > 0) {
    missingTotal += missing.length;
    console.log(`[${locale}] ${missing.length} untranslated strings:`);
    for (const key of missing) {
      console.log(`  ${JSON.stringify(key)},`);
    }
  } else {
    console.log(`[${locale}] all ${keys.size} strings translated`);
  }
}

console.log(`extracted ${keys.size} localizable strings -> l10n/`);
if (process.argv.includes('--check') && missingTotal > 0) {
  process.exitCode = 1;
}
