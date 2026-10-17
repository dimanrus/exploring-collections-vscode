import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The tests are bundled to CommonJS, so `__dirname` is `<repo>/out/test`.
const root = join(__dirname, '..', '..');
const extensionVersion = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
).version;

/**
 * Every bundled helper declares its own version, and all of them follow the
 * extension release, so one bump moves the whole set. The built in
 * JavaScript/TypeScript serializer ships inside the extension and has no
 * declaration of its own, and the envelope revision (`__ec`) is a protocol
 * version that stays independent of the release version.
 */
const declarations: { helper: string; file: string; pattern: RegExp }[] = [
  {
    helper: '.NET (C#/F#) assembly',
    file: 'helpers/dotnet/ExploringCollections.Helper.csproj',
    pattern: /<Version>([^<]+)<\/Version>/
  },
  {
    helper: 'Python module',
    file: 'helpers/python/exploring_collections_helper.py',
    pattern: /^__version__ = "([^"]+)"/m
  },
  {
    helper: 'Go package',
    file: 'helpers/go/exploring_collections.go',
    pattern: /^const Version = "([^"]+)"/m
  },
  {
    helper: 'Rust module',
    file: 'helpers/rust/exploring_collections.rs',
    pattern: /pub const VERSION: &str = "([^"]+)";/
  },
  {
    helper: 'Rust crate',
    file: 'helpers/rust/Cargo.toml',
    pattern: /^version = "([^"]+)"/m
  },
  {
    helper: 'Rust lock file',
    file: 'helpers/rust/Cargo.lock',
    pattern: /name = "exploring-collections-helper"\r?\nversion = "([^"]+)"/
  },
  {
    helper: 'C/C++ header',
    file: 'helpers/cc/exploring_collections.h',
    pattern: /#define EXPLORING_COLLECTIONS_VERSION "([^"]+)"/
  }
];

describe('helper versions', () => {
  it('declares the extension version for every helper', () => {
    for (const { helper, file, pattern } of declarations) {
      const source = readFileSync(join(root, file), 'utf8');
      const match = pattern.exec(source);
      assert.ok(match, `${helper}: no version declaration found in ${file}`);
      assert.equal(
        match[1],
        extensionVersion,
        `${helper}: ${file} declares ${match[1]}, expected the extension version ${extensionVersion}`
      );
    }
  });
});
