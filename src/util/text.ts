/**
 * Text helpers shared by the cell formatter, the exporters and the webview.
 * Everything here is pure so it can be unit tested without VS Code.
 */

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;'
};

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Escapes a value for use inside XML text or attribute content. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

/** Strips characters that are illegal in XML 1.0 documents. */
export function stripInvalidXmlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTERS, '');
}

/** Escapes one CSV field following RFC 4180. */
export function escapeCsvField(value: string, delimiter: string, quote: string): string {
  const needsQuoting =
    value.includes(delimiter) ||
    value.includes(quote) ||
    value.includes('\n') ||
    value.includes('\r') ||
    value !== value.trim();

  if (!needsQuoting) {
    return value;
  }
  const escapedQuote = quote + quote;
  return quote + value.split(quote).join(escapedQuote) + quote;
}

/** Escapes a string so it can be embedded in a `<script>` block inside HTML. */
export function escapeHtmlForScript(value: string): string {
  return value
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--');
}

/** Truncates `value` to `max` characters, appending an ellipsis when cut. */
export function truncate(value: string, max: number): string {
  if (max <= 0 || value.length <= max) {
    return value;
  }
  if (max === 1) {
    return '…';
  }
  return value.slice(0, max - 1) + '…';
}

/** Collapses all whitespace runs into single spaces and trims the result. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Converts an arbitrary string into a safe file name. */
export function sanitizeFileName(value: string, fallback = 'collection'): string {
  const sanitized = value
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 120);
  return sanitized.length > 0 ? sanitized : fallback;
}

/** Formats a duration in milliseconds for human readable diagnostics. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

/** Formats a byte count using binary units. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** Parses a debugger string such as `{City="Seoul", DegreeCelsius=21}` into pairs. */
export function parseBracedMembers(value: string): Array<{ name: string; value: string }> {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return [];
  }
  const body = trimmed.slice(1, -1);
  const members: Array<{ name: string; value: string }> = [];
  let depth = 0;
  let inString = false;
  let current = '';
  const fragments: string[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] as string;
    if (inString) {
      current += character;
      if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      current += character;
      continue;
    }
    if (character === '{' || character === '[' || character === '(') {
      depth += 1;
    } else if (character === '}' || character === ']' || character === ')') {
      depth -= 1;
    }
    if (character === ',' && depth === 0) {
      fragments.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  fragments.push(current);

  for (const fragment of fragments) {
    const separator = findTopLevelSeparator(fragment);
    if (separator < 0) {
      continue;
    }
    const name = fragment.slice(0, separator).trim();
    const memberValue = fragment.slice(separator + 1).trim();
    if (name.length > 0) {
      members.push({ name, value: memberValue });
    }
  }
  return members;
}

function findTopLevelSeparator(fragment: string): number {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < fragment.length; index += 1) {
    const character = fragment[index] as string;
    if (inString) {
      if (character === '"') {
        inString = false;
      }
      continue;
    }
    switch (character) {
      case '"':
        inString = true;
        break;
      case '{':
      case '[':
      case '(':
        depth += 1;
        break;
      case '}':
      case ']':
      case ')':
        depth -= 1;
        break;
      case '=':
        if (depth === 0) {
          return index;
        }
        break;
      default:
        break;
    }
  }
  return -1;
}
