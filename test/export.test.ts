import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

import { buildSnapshot, type ElementNode } from '../src/model/snapshotBuilder';
import type { CollectionSnapshot, SnapshotDiagnostics } from '../src/model/types';
import {
  extensionFor,
  isExportFormat,
  labelFor,
  toCsv,
  toJson,
  toXml,
  toXmlName
} from '../src/export/textFormats';
import { buildXlsx, columnLetter, sanitizeSheetName } from '../src/export/xlsx';
import { crc32, createZipArchive } from '../src/export/zip';

const diagnostics: SnapshotDiagnostics = {
  strategy: 'helper-json',
  durationMs: 0,
  requests: 0,
  reportedItemCount: null,
  fallbackReasons: [],
  notes: []
};

const elements: ElementNode[] = [
  {
    label: '[0]',
    fields: [
      { name: 'City', path: ['City'], text: 'Seoul', kind: 'string' },
      { name: 'DegreeCelsius', path: ['DegreeCelsius'], text: '21', kind: 'number' },
      { name: 'Feels', path: ['Feels'], text: 'cold, windy', kind: 'string' }
    ]
  },
  {
    label: '[1]',
    fields: [
      { name: 'City', path: ['City'], text: 'Lima "capital"', kind: 'string' },
      { name: 'DegreeCelsius', path: ['DegreeCelsius'], text: '19', kind: 'number' },
      { name: 'Feels', path: ['Feels'], text: '', kind: 'null', isNull: true }
    ]
  }
];

const snapshot: CollectionSnapshot = buildSnapshot({
  id: 'snap-export',
  title: 'temperatures',
  expression: 'temperatures',
  sessionId: 'session',
  sessionName: 'Demo',
  debugType: 'coreclr',
  language: 'csharp',
  providerId: 'csharp',
  elements,
  diagnostics
});

describe('export formats', () => {
  it('reports format metadata', () => {
    assert.equal(isExportFormat('csv'), true);
    assert.equal(isExportFormat('yaml'), false);
    assert.equal(extensionFor('xlsx'), 'xlsx');
    assert.match(labelFor('xlsx'), /Excel/);
    assert.equal(toXmlName('address.zip'), 'address.zip');
    assert.equal(toXmlName('2 fast'), '_2_fast');
  });

  it('writes RFC 4180 CSV with escaped fields', () => {
    const csv = toCsv({ snapshot });
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line.length > 0);
    assert.equal(lines[0], '#,City,DegreeCelsius,Feels');
    assert.equal(lines[1], '[0],Seoul,21,"cold, windy"');
    assert.equal(lines[2], '[1],"Lima ""capital""",19,');
  });

  it('supports custom delimiters and disables the BOM on request', () => {
    const csv = toCsv({ snapshot }, { delimiter: '\t', byteOrderMark: false, lineEnding: '\n' });
    assert.equal(csv.startsWith('\uFEFF'), false);
    const lines = csv.split('\n').filter((line) => line.length > 0);
    assert.equal(lines[0], '#\tCity\tDegreeCelsius\tFeels');
    assert.equal(lines[1], '[0]\tSeoul\t21\tcold, windy');
  });

  it('exports a column subset', () => {
    const csv = toCsv({ snapshot, columns: [snapshot.columns[1]!, snapshot.columns[2]!] });
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line.length > 0);
    assert.equal(lines[0], 'City,DegreeCelsius');
    assert.equal(lines[1], 'Seoul,21');
  });

  it('writes typed JSON values', () => {
    const parsed = JSON.parse(toJson({ snapshot })) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.DegreeCelsius, 21);
    assert.equal(parsed[1]!.Feels, null);
    assert.equal(parsed[1]!.City, 'Lima "capital"');
  });

  it('adds metadata when requested', () => {
    const document = JSON.parse(toJson({ snapshot }, { includeMetadata: true, pretty: false })) as Record<
      string,
      unknown
    >;
    assert.equal(document.collection, 'temperatures');
    assert.equal(document.expression, 'temperatures');
    assert.equal(document.exportedRows, 2);
    assert.ok(Array.isArray(document.columns));
    assert.ok(Array.isArray(document.rows));
  });

  it('honours the pretty printing switch', () => {
    assert.equal(toJson({ snapshot }, { pretty: false }).includes('\n'), false);
    assert.equal(toJson({ snapshot }, { pretty: true }).includes('\n'), true);
  });

  it('writes well formed XML with null markers', () => {
    const xml = toXml({ snapshot });
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<collection name="temperatures"/);
    assert.match(xml, /<City>Seoul<\/City>/);
    assert.match(xml, /<City>Lima &quot;capital&quot;<\/City>/);
    assert.match(xml, /<Feels null="true"\/>/);
    assert.match(xml, /<Feels>cold, windy<\/Feels>/);
    // No unescaped ampersands or quotes inside element content.
    assert.equal(/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), false);
  });

  it('avoids duplicate XML element names', () => {
    const cloned = buildSnapshot({
      id: 'dup',
      title: 'dup',
      expression: 'dup',
      sessionId: 's',
      sessionName: 's',
      debugType: 'coreclr',
      language: 'csharp',
      providerId: 'csharp',
      elements: [
        {
          label: '[0]',
          fields: [
            { name: 'A.B', path: ['A.B'], text: '1', kind: 'number' },
            { name: 'A_B', path: ['A_B'], text: '2', kind: 'number' }
          ]
        }
      ],
      diagnostics
    });
    const xml = toXml({ snapshot: cloned });
    // Both columns survive as distinct element names, and the synthetic index
    // column becomes a legal XML name.
    assert.match(xml, /<A\.B>1<\/A\.B>/);
    assert.match(xml, /<A_B>2<\/A_B>/);
    assert.match(xml, /<_>\[0\]<\/_>/);
    const names = [...xml.matchAll(/<([A-Za-z_.][\w.\-]*)>/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(names)].sort(), ['A.B', 'A_B', '_'].sort());
    assert.equal(names.length, new Set(names).size, 'element names must stay unique');
  });

  it('keeps values alive through every format', () => {
    for (const format of ['csv', 'json', 'xml'] as const) {
      const text =
        format === 'csv'
          ? toCsv({ snapshot })
          : format === 'json'
            ? toJson({ snapshot })
            : toXml({ snapshot });
      assert.ok(text.includes('Seoul'), `${format} lost the data`);
    }
  });
});

describe('xlsx writer', () => {
  it('computes Excel column letters', () => {
    assert.equal(columnLetter(0), 'A');
    assert.equal(columnLetter(25), 'Z');
    assert.equal(columnLetter(26), 'AA');
    assert.equal(columnLetter(701), 'ZZ');
    assert.equal(columnLetter(702), 'AAA');
  });

  it('sanitizes worksheet names', () => {
    assert.equal(sanitizeSheetName('temperatures'), 'temperatures');
    assert.equal(sanitizeSheetName('a/b:c*d?e[f]g'), 'a_b_c_d_e_f_g');
    assert.equal(sanitizeSheetName(''), 'Sheet');
    assert.equal(sanitizeSheetName('x'.repeat(60)).length, 31);
  });

  it('computes CRC-32 the way the ZIP specification requires', () => {
    // Reference value for "123456789".
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  });

  it('produces a readable ZIP archive', () => {
    const archive = createZipArchive([
      { path: 'a.txt', content: 'hello' },
      { path: 'nested/b.txt', content: 'x'.repeat(5000) }
    ]);
    const entries = readZip(archive);
    assert.equal(entries.get('a.txt'), 'hello');
    assert.equal(entries.get('nested/b.txt'), 'x'.repeat(5000));
  });

  it('throws a valid workbook that unzips and carries the data', () => {
    const workbook = buildXlsx([{ name: 'temperatures', snapshot }]);
    const entries = readZip(workbook);

    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'docProps/core.xml',
      'docProps/app.xml'
    ]) {
      assert.ok(entries.has(required), `missing part ${required}`);
    }

    const sheet = entries.get('xl/worksheets/sheet1.xml')!;
    assert.match(sheet, /<row r="1">/);
    assert.match(sheet, /<t xml:space="preserve">#<\/t>/);
    assert.match(sheet, /<t xml:space="preserve">City<\/t>/);
    assert.match(sheet, /<t xml:space="preserve">Seoul<\/t>/);
    // Numbers are written as numeric cells, strings as inline strings.
    assert.match(sheet, /<c r="C2"[^>]*><v>21<\/v><\/c>/);
    assert.match(sheet, /t="inlineStr"/);
    assert.match(sheet, /<autoFilter ref="A1:D3"\/>/);

    const workbookXml = entries.get('xl/workbook.xml')!;
    assert.match(workbookXml, /<sheet name="temperatures"/);
  });

  it('deduplicates worksheet names', () => {
    const workbook = buildXlsx([
      { name: 'same', snapshot },
      { name: 'same', snapshot }
    ]);
    const entries = readZip(workbook);
    const workbookXml = entries.get('xl/workbook.xml')!;
    const names = [...workbookXml.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.length, 2);
  });

  it('writes boolean and empty cells correctly', () => {
    const withFlag = buildSnapshot({
      id: 'flag',
      title: 'flag',
      expression: 'flag',
      sessionId: 's',
      sessionName: 's',
      debugType: 'coreclr',
      language: 'csharp',
      providerId: 'csharp',
      elements: [
        {
          label: '[0]',
          fields: [
            { name: 'Raining', path: ['Raining'], text: 'true', kind: 'boolean' },
            { name: 'Note', path: ['Note'], text: '', kind: 'null', isNull: true }
          ]
        }
      ],
      diagnostics
    });
    const sheet = readZip(buildXlsx([{ name: 'flag', snapshot: withFlag }])).get('xl/worksheets/sheet1.xml')!;
    assert.match(sheet, /t="b"[^>]*><v>1<\/v>/);
    assert.match(sheet, /<dimension ref="A1:C2"\/>/);
  });
});

/** Reads a ZIP archive the way a compliant consumer would, checking each entry. */
function readZip(buffer: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      break;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(content.length, uncompressedSize, `wrong size for ${name}`);
    assert.equal(crc32(content), expectedCrc, `wrong CRC for ${name}`);
    entries.set(name, content.toString('utf8'));
    offset = dataStart + compressedSize;
  }
  assert.ok(entries.size > 0, 'the archive contained no entries');
  // Central directory must be present as well.
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  return entries;
}
