import { elementFromRawValue, unwrapSerializedPayload } from './variablesWalk';
import type { ElementNode } from '../model/snapshotBuilder';

/**
 * Structured envelope produced by the bundled helpers. Using an explicit
 * envelope instead of a bare array keeps the element count, the container kind
 * and the dictionary keys available to the UI.
 *
 * ```json
 * { "__ec": 1, "kind": "sequence", "total": 14, "items": [ ... ] }
 * ```
 */
export interface CollectionEnvelope {
  kind: 'sequence' | 'mapping' | 'record';
  total: number | null;
  items: unknown[];
}

export const ENVELOPE_MARKER = '__ec';

/**
 * Parses a JSON payload produced by a serializing helper. Debuggers frequently
 * double encode the result (the payload arrives as a quoted JSON string) and
 * some adapters append decoration such as `(length=123)`, so the parser is
 * deliberately forgiving.
 */
export function tryParseJson(text: string): unknown {
  let candidate = unwrapSerializedPayload(text);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (candidate.length === 0) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'string') {
        candidate = parsed;
        continue;
      }
      return parsed;
    } catch {
      const trimmed = trimAdapterDecoration(candidate);
      if (trimmed !== candidate) {
        candidate = trimmed;
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

/**
 * True when the adapter cut the payload instead of handing it over in one piece.
 *
 * Adapters elide long `evaluate` results in the middle (`{"a":1,…,"z":26}`), and
 * that text can still parse as JSON — with mangled members and missing rows — so
 * a cut payload has to be recognised before it is mistaken for a small one.
 */
export function isCutPayload(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.includes('…')) {
    return true;
  }
  if (/\.\.\.\s*\((?:length|len)=\d+\)$/s.test(trimmed)) {
    return true;
  }
  return trimmed.endsWith('...') && trimmed.startsWith('{');
}

function trimAdapterDecoration(text: string): string {
  const decorated = /^(.*?)(?:\.\.\.|…)?\s*\((?:length|len)=\d+\)$/s.exec(text);
  if (decorated?.[1]) {
    return decorated[1];
  }
  const trailing = /^(.*?)(?:\.\.\.|…)$/s.exec(text.trim());
  if (trailing?.[1]) {
    return trailing[1];
  }
  return text;
}

/** True when the parsed payload follows the helper envelope contract. */
export function isEnvelope(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[ENVELOPE_MARKER] === 'number'
  );
}

/** Extracts the envelope from a parsed payload, accepting loose shapes too. */
export function readEnvelope(value: unknown): CollectionEnvelope | undefined {
  if (isEnvelope(value)) {
    const record = value as Record<string, unknown>;
    const kind = record.kind;
    const rawItems = Array.isArray(record.items)
      ? record.items
      : Array.isArray(record.data)
        ? record.data
        : undefined;
    if (rawItems) {
      const normalizedKind =
        kind === 'mapping' || kind === 'record' || kind === 'sequence' ? kind : 'sequence';
      return {
        kind: normalizedKind,
        total: typeof record.total === 'number' ? record.total : null,
        items: rawItems
      };
    }
    return undefined;
  }

  const wrapper = findArrayMember(value);
  if (wrapper) {
    return { kind: 'sequence', total: wrapper.items.length, items: wrapper.items };
  }
  return undefined;
}

/** Converts an envelope into element nodes. */
export function elementsFromEnvelope(envelope: CollectionEnvelope, maxRows: number): ElementNode[] {
  const items = envelope.items.length > maxRows ? envelope.items.slice(0, maxRows) : envelope.items;
  if (envelope.kind === 'mapping') {
    return items.map((entry, index) => {
      const pair = Array.isArray(entry) ? entry : [index, entry];
      const key = pair[0];
      const value = pair.length > 1 ? pair[1] : undefined;
      return elementFromRawValue(value, index, formatKeyLabel(key));
    });
  }
  return items.map((entry, index) => elementFromRawValue(entry, index));
}

function formatKeyLabel(key: unknown): string {
  if (typeof key === 'string') {
    return key;
  }
  if (key === null || key === undefined) {
    return 'null';
  }
  if (typeof key === 'object') {
    try {
      return JSON.stringify(key) ?? String(key);
    } catch {
      return String(key);
    }
  }
  return String(key);
}

/**
 * Converts any helper payload into element nodes. Envelopes are preferred;
 * a bare array or object payload is accepted for user supplied helpers.
 */
export function elementsFromPayload(text: string, maxRows: number): ElementNode[] | undefined {
  const parsed = tryParseJson(text);
  if (parsed === undefined) {
    return undefined;
  }
  const envelope = readEnvelope(parsed);
  if (envelope) {
    return elementsFromEnvelope(envelope, maxRows);
  }
  if (Array.isArray(parsed)) {
    return elementsFromJsonPayload(parsed, maxRows);
  }
  if (typeof parsed === 'object' && parsed !== null) {
    return [elementFromRawValue(parsed, 0, 'record')];
  }
  return [elementFromRawValue(parsed, 0, 'value')];
}

/** Reads the element count an envelope payload reports, when present. */
export function totalFromPayload(text: string): number | null {
  const parsed = tryParseJson(text);
  if (parsed === undefined) {
    return null;
  }
  const envelope = readEnvelope(parsed);
  return envelope?.total ?? null;
}

/** Converts a parsed payload into element nodes, or `undefined` when unusable. */
export function elementsFromJsonPayload(value: unknown, maxRows: number): ElementNode[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const limited = value.length > maxRows ? value.slice(0, maxRows) : value;
    return limited.map((entry, index) => elementFromRawValue(entry, index));
  }
  if (typeof value === 'object') {
    const wrapper = findArrayMember(value);
    if (wrapper) {
      const limited = wrapper.items.length > maxRows ? wrapper.items.slice(0, maxRows) : wrapper.items;
      return limited.map((entry, index) => elementFromRawValue(entry, index));
    }
    return [elementFromRawValue(value, 0, 'record')];
  }
  return [elementFromRawValue(value, 0, 'value')];
}

function findArrayMember(value: unknown): { name: string; items: unknown[] } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const preferred = ['items', 'data', 'values', 'rows', 'entries', 'elements', 'result', 'results'];
  for (const name of preferred) {
    const candidate = record[name];
    if (Array.isArray(candidate)) {
      return { name, items: candidate };
    }
  }
  const keys = Object.keys(record);
  if (keys.length === 1) {
    const only = keys[0] as string;
    const candidate = record[only];
    if (Array.isArray(candidate)) {
      return { name: only, items: candidate };
    }
  }
  return undefined;
}
