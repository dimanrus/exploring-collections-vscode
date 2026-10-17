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
 * The bundled .NET helper declares its own version, which follows the extension
 * release. The built in JavaScript/TypeScript serializer ships inside the
 * extension and has no declaration of its own, and the envelope revision
 * (`__ec`) is a protocol version that stays independent of the release version.
 */
const declarations: { helper: string; file: string; pattern: RegExp }[] = [
  {
    helper: '.NET (C#/F#) assembly',
    file: 'helpers/dotnet/ExploringCollections.Helper.csproj',
    pattern: /<Version>([^<]+)<\/Version>/
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
