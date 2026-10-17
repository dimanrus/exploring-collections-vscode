/**
 * Parses the compact object preview that debug adapters put in a variable's
 * `value` (`{id: 0, name: 'Emp0'}`).
 *
 * The variables walk normally costs one request per expanded element. Adapters
 * such as js-debug return every child of an array in one `variables` response
 * and each child already carries its members in the preview, so a complete
 * preview can be turned into columns without any further requests.
 *
 * Only flat, complete previews are accepted: anything elided by the adapter
 * (`…`, `[Object]`, `{…}`, `[Array(3)]`) or containing nested containers makes
 * the parser return `undefined`, and the caller falls back to expanding the
 * element through the adapter.
 */

export type PreviewPrimitive = string | number | boolean | null;

/** Members of a fully described preview. */
export type ParsedPreview = Record<string, PreviewPrimitive>;

const INCOMPLETE_MARKERS = [
  '…',
  '[Object]',
  '{…}',
  '[Array(',
  '[Map(',
  '[Set(',
  '[Function',
  '[Circular]',
  '[Thrown'
];

/** Type prefix some adapters put before the braces, e.g. `Temperature {…}`. */
const TYPE_PREFIX = /^(?:[A-Za-z_$][\w$.]*)?\s*$/;

/**
 * Parses `{a: 1, b: 'x'}`, `Temperature {a: 1}` or `{}` into plain members.
 * Returns `undefined` when the text is not a complete, flat object preview.
 */
export function parsePreviewObject(text: string | undefined): ParsedPreview | undefined {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim();
  if (!trimmed.endsWith('}')) {
    return undefined;
  }
  const braced = trimmed.indexOf('{');
  if (braced < 0 || !TYPE_PREFIX.test(trimmed.slice(0, braced))) {
    return undefined;
  }
  if (INCOMPLETE_MARKERS.some((marker) => trimmed.includes(marker))) {
    return undefined;
  }

  const body = trimmed.slice(braced + 1, -1);
  const result: ParsedPreview = {};
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < body.length && /\s/.test(body[index] as string)) {
      index += 1;
    }
  };

  const readString = (quote: string): string | undefined => {
    index += 1;
    let value = '';
    while (index < body.length) {
      const character = body[index] as string;
      index += 1;
      if (character === quote) {
        return value;
      }
      if (character !== '\\') {
        value += character;
        continue;
      }
      const escaped = body[index] as string | undefined;
      index += 1;
      switch (escaped) {
        case 'n':
          value += '\n';
          break;
        case 'r':
          value += '\r';
          break;
        case 't':
          value += '\t';
          break;
        case 'b':
          value += '\b';
          break;
        case 'f':
          value += '\f';
          break;
        case '0':
          value += '\0';
          break;
        case 'u': {
          const hex = body.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            return undefined;
          }
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
          break;
        }
        case undefined:
          return undefined;
        default:
          value += escaped;
          break;
      }
    }
    return undefined;
  };

  const readValue = (): PreviewPrimitive | undefined => {
    const character = body[index];
    if (character === "'" || character === '"') {
      const value = readString(character);
      return value === undefined ? undefined : value;
    }
    const rest = body.slice(index);
    const primitive = /^(true|false|null|undefined|NaN|Infinity|-Infinity|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?)/.exec(rest);
    if (!primitive) {
      return undefined;
    }
    index += primitive[0].length;
    const token = primitive[0];
    if (token === 'true') {
      return true;
    }
    if (token === 'false') {
      return false;
    }
    if (token === 'null' || token === 'undefined') {
      return null;
    }
    if (token === 'NaN') {
      return Number.NaN;
    }
    if (token === 'Infinity' || token === '-Infinity') {
      return token === 'Infinity' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    }
    if (token.endsWith('n')) {
      // A bigint is shown as a value and its digits; keeping the digits as text
      // is lossless enough for a table cell.
      return token;
    }
    return Number(token);
  };

  for (;;) {
    skipWhitespace();
    if (index >= body.length) {
      break;
    }
    if (body[index] === ',') {
      index += 1;
      continue;
    }

    let name: string | undefined;
    const character = body[index] as string;
    if (character === "'" || character === '"') {
      name = readString(character);
    } else {
      const key = /^[A-Za-z_$][\w$]*|^\d+/.exec(body.slice(index));
      if (key) {
        name = key[0];
        index += name.length;
      }
    }
    if (name === undefined) {
      return undefined;
    }

    skipWhitespace();
    if (body[index] !== ':') {
      return undefined;
    }
    index += 1;
    skipWhitespace();

    const value = readValue();
    if (value === undefined) {
      return undefined;
    }
    result[name] = value;
  }

  return result;
}
