import { escapeXml, stripInvalidXmlCharacters, truncate } from '../util/text';
import type { CollectionSnapshot, RowDescriptor } from '../model/types';
import { createZipArchive, type ZipEntry } from './zip';

/** Excel worksheet limits. */
const MAX_ROWS = 1048576;
const MAX_COLUMNS = 16384;
const MAX_CELL_CHARACTERS = 32767;

export interface XlsxSheet {
  name: string;
  snapshot: CollectionSnapshot;
  /** Optional subset of rows; defaults to every row of the snapshot. */
  rows?: readonly RowDescriptor[];
}

export interface XlsxOptions {
  /** Freeze the first row so headers stay visible while scrolling. */
  freezeHeader?: boolean;
  /** Add an autofilter over the header row. */
  autoFilter?: boolean;
  createdAt?: Date;
}

/** Converts a zero based column index into its Excel letter (`A`, `AA`, ...). */
export function columnLetter(index: number): string {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

/** Makes a string usable as an Excel worksheet name. */
export function sanitizeSheetName(name: string, fallback = 'Sheet'): string {
  const cleaned = name.replace(/[\\/:*?[\]]+/g, '_').replace(/^'+|'+$/g, '').trim();
  const safe = cleaned.length > 0 ? cleaned : fallback;
  return truncate(safe, 31);
}

interface XlsxCell {
  text: string;
  kind: 'string' | 'number' | 'boolean' | 'empty';
  number?: number;
  boolean?: boolean;
}

function toXlsxCell(text: string, isNull: boolean, numericHint: boolean): XlsxCell {
  if (isNull || text.length === 0) {
    return { text: '', kind: 'empty' };
  }
  if (numericHint) {
    const cleaned = text.replace(/,/g, '').replace(/[fFdDmMlLuU]+$/, '');
    const value = Number(cleaned);
    if (cleaned.length > 0 && Number.isFinite(value)) {
      return { text, kind: 'number', number: value };
    }
  }
  if (text === 'true' || text === 'false') {
    return { text, kind: 'boolean', boolean: text === 'true' };
  }
  return { text, kind: 'string' };
}

function cellXml(reference: string, cell: XlsxCell, styleIndex: number): string {
  const style = styleIndex > 0 ? ` s="${styleIndex}"` : '';
  switch (cell.kind) {
    case 'empty':
      return styleIndex > 0 ? `<c r="${reference}"${style}/>` : '';
    case 'number':
      return `<c r="${reference}"${style}><v>${cell.number}</v></c>`;
    case 'boolean':
      return `<c r="${reference}" t="b"${style}><v>${cell.boolean ? 1 : 0}</v></c>`;
    default: {
      const value = escapeXml(stripInvalidXmlCharacters(truncate(cell.text, MAX_CELL_CHARACTERS)));
      return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${value}</t></is></c>`;
    }
  }
}

function sheetXml(sheet: XlsxSheet, options: XlsxOptions): string {
  const { snapshot } = sheet;
  const rows = sheet.rows ?? snapshot.rows;
  const visibleColumns = snapshot.columns.slice(0, MAX_COLUMNS);
  const limitedRows = rows.slice(0, MAX_ROWS - 1);

  const headerCells = visibleColumns
    .map((column, index) => cellXml(`${columnLetter(index)}1`, { text: column.key, kind: 'string' }, 1))
    .join('');

  const bodyRows = limitedRows
    .map((row, rowIndex) => {
      const excelRow = rowIndex + 2;
      const cells = visibleColumns
        .map((column, columnIndex) => {
          const cellPosition = snapshot.columns.indexOf(column);
          const cell = row.cells[cellPosition];
          if (!cell) {
            return '';
          }
          const numericHint = column.kind === 'number';
          const converted = toXlsxCell(cell.text, cell.isNull, numericHint);
          return cellXml(`${columnLetter(columnIndex)}${excelRow}`, converted, 0);
        })
        .join('');
      return `<row r="${excelRow}">${cells}</row>`;
    })
    .join('');

  const lastColumn = columnLetter(Math.max(0, visibleColumns.length - 1));
  const dimension = `A1:${lastColumn}${limitedRows.length + 1}`;
  const freeze = options.freezeHeader === false
    ? ''
    : '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>';
  const filter =
    options.autoFilter !== false && visibleColumns.length > 0
      ? `<autoFilter ref="${dimension}"/>`
      : '';

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="${dimension}"/>`,
    freeze,
    '<sheetFormatPr defaultRowHeight="15"/>',
    `<sheetData><row r="1">${headerCells}</row>${bodyRows}</sheetData>`,
    filter,
    '</worksheet>'
  ].join('');
}

const CONTENT_TYPES_HEADER = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '<Default Extension="xml" ContentType="application/xml"/>',
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
];

const STYLES_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  '<fonts count="2">',
  '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>',
  '</fonts>',
  '<fills count="3">',
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF3FA"/><bgColor indexed="64"/></patternFill></fill>',
  '</fills>',
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
  '<cellXfs count="2">',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>',
  '</cellXfs>',
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
  '</styleSheet>'
].join('');

function coreProperties(sheets: readonly XlsxSheet[], createdAt: Date): string {
  const title = escapeXml(sheets.map((sheet) => sheet.name).join(', '));
  const iso = createdAt.toISOString().replace(/\.\d+Z$/, 'Z');
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ',
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ',
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '<dc:title>' + title + '</dc:title>',
    '<dc:creator>Exploring Collections for VS Code</dc:creator>',
    '<cp:lastModifiedBy>Exploring Collections for VS Code</cp:lastModifiedBy>',
    `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>`,
    '</cp:coreProperties>'
  ].join('');
}

function appProperties(sheets: readonly XlsxSheet[]): string {
  const titles = sheets
    .map((sheet) => `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ',
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    '<Application>Exploring Collections for VS Code</Application>',
    `<TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>`,
    '<HeadingPairs><vt:vector size="2" baseType="variant">',
    '<vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>',
    `<vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant>`,
    '</vt:vector></HeadingPairs>',
    '</Properties>'
  ].join('');
}

/** Builds a real `.xlsx` workbook (Office Open XML, zip container). */
export function buildXlsx(sheets: readonly XlsxSheet[], options: XlsxOptions = {}): Buffer {
  const createdAt = options.createdAt ?? new Date();
  const normalized = sheets.length > 0 ? sheets : [{ name: 'Sheet1', snapshot: emptySnapshot() }];
  const usedNames = new Set<string>();
  const names = normalized.map((sheet, index) => {
    let candidate = sanitizeSheetName(sheet.name, `Sheet${index + 1}`);
    let suffix = 1;
    while (usedNames.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = sanitizeSheetName(`${candidate}_${suffix}`, `Sheet${index + 1}`);
    }
    usedNames.add(candidate.toLowerCase());
    return candidate;
  });

  const entries: ZipEntry[] = [];

  entries.push({
    path: '[Content_Types].xml',
    content: [
      ...CONTENT_TYPES_HEADER,
      ...normalized.map(
        (_sheet, index) =>
          `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      ),
      '</Types>'
    ].join('')
  });

  entries.push({
    path: '_rels/.rels',
    content: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
      '</Relationships>'
    ].join('')
  });

  entries.push({
    path: 'docProps/core.xml',
    content: coreProperties(normalized, createdAt)
  });

  entries.push({
    path: 'docProps/app.xml',
    content: appProperties(normalized)
  });

  entries.push({
    path: 'xl/workbook.xml',
    content: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ',
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      '<sheets>',
      ...names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`),
      '</sheets>',
      '</workbook>'
    ].join('')
  });

  entries.push({
    path: 'xl/_rels/workbook.xml.rels',
    content: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      ...normalized.map(
        (_sheet, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
      ),
      `<Relationship Id="rId${normalized.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
      '</Relationships>'
    ].join('')
  });

  entries.push({ path: 'xl/styles.xml', content: STYLES_XML });

  normalized.forEach((sheet, index) => {
    entries.push({
      path: `xl/worksheets/sheet${index + 1}.xml`,
      content: sheetXml(sheet, options)
    });
  });

  return createZipArchive(entries, createdAt);
}

function emptySnapshot(): CollectionSnapshot {
  return {
    id: 'empty',
    title: 'Sheet1',
    expression: '',
    sessionId: '',
    sessionName: '',
    debugType: '',
    language: '',
    providerId: '',
    capturedAt: Date.now(),
    columns: [],
    rows: [],
    totalItems: 0,
    truncated: false,
    warnings: [],
    diagnostics: {
      strategy: 'variables-walk',
      durationMs: 0,
      requests: 0,
      reportedItemCount: 0,
      fallbackReasons: [],
      notes: []
    }
  };
}
