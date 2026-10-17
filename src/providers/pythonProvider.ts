import type { ElementNode } from '../model/snapshotBuilder';
import { emitBody } from '../filter/emit';
import { PYTHON_DIALECT } from '../filter/dialects';
import { AbstractLanguageProvider } from './baseProvider';
import { elementsFromPayload } from './jsonPayload';
import type { FilterEmitInput, FilterTranslation, HelperOptions, LanguageId } from './languageProvider';

/** Debug types owned by debugpy. */
export const PYTHON_DEBUG_TYPES = ['python', 'debugpy', 'python-experimental'] as const;

/** Relative path of the helper module shipped with the extension. */
export const PYTHON_HELPER_PATH = 'python/exploring_collections_helper.py';

/** Name of the namespace the helper is executed into inside the debuggee. */
const HELPER_NAMESPACE = '__ec_ns';

/** Python string literal for a chunk of source code. */
export function pythonStringLiteral(value: string): string {
  const escaped = JSON.stringify(value);
  return escaped ?? '""';
}

/**
 * Builds the expression that executes the helper module inside the debuggee and
 * calls `__ec_dump`. A single name (`__ec_ns`) is added to the module globals.
 */
export function buildPythonHelperCall(source: string, helperSource: string): string {
  return (
    `__import__('builtins').exec(${pythonStringLiteral(helperSource)}, ` +
    `__import__('builtins').globals().setdefault(${pythonStringLiteral(HELPER_NAMESPACE)}, {})) ` +
    `or ${HELPER_NAMESPACE}['__ec_dump'](${source})`
  );
}

/**
 * Self contained fallback that does not need the helper module: a single
 * expression using `json.dumps` with a tolerant `default` hook.
 */
export function buildPythonInlineSerializer(source: string): string {
  const defaultHook =
    "(lambda __o: __o.isoformat() if hasattr(__o, 'isoformat') "
    + "else (__o._asdict() if hasattr(__o, '_asdict') "
    + "else (vars(__o) if hasattr(__o, '__dict__') "
    + "else (list(__o) if hasattr(__o, '__iter__') else str(__o)))))";
  const sequenceTypes = '(list, tuple, set, frozenset, range)';
  const envelope =
    "{'__ec': 1, "
    + `'kind': ('mapping' if isinstance(__v, dict) else ('sequence' if isinstance(__v, ${sequenceTypes}) else 'record')), `
    + `'total': (len(__v) if isinstance(__v, (dict, ${sequenceTypes})) else None), `
    + `'items': ([[__k, __v[__k]] for __k in list(__v)[:100000]] if isinstance(__v, dict) `
    + `else (list(__v)[:100000] if isinstance(__v, ${sequenceTypes}) else [__v]))}`;
  return (
    `(lambda __v: __import__('json').dumps(${envelope}, default=${defaultHook}, `
    + "ensure_ascii=False, sort_keys=False))"
    + `(${source})`
  );
}

/** Python provider: helper module injection with a self contained fallback. */
export class PythonProvider extends AbstractLanguageProvider {
  override readonly id = 'python';
  override readonly language: LanguageId = 'python';
  override readonly displayName = 'Python';
  override readonly debugTypes = PYTHON_DEBUG_TYPES;
  override readonly editorLanguages = ['python'];
  override readonly adapterHints = ['debugpy'];
  override readonly notes = [
    'The helper module is executed inside the debuggee and stores a single name (__ec_ns) in the module globals.',
    'Filters are pushed down as `filter(lambda x: ...)` when the collection is larger than the fetched window.',
    'Python 3 only: debugpy does not support Python 2.'
  ];

  override buildSerializeExpression(source: string, options: HelperOptions): string[] {
    const candidates: string[] = [];
    const helperSource = options.readHelper?.(PYTHON_HELPER_PATH);
    if (helperSource && helperSource.trim().length > 0) {
      candidates.push(buildPythonHelperCall(source, helperSource));
    }
    candidates.push(buildPythonInlineSerializer(source));
    return candidates;
  }

  override parseSerializedPayload(payload: string): ElementNode[] | undefined {
    return elementsFromPayload(payload, Number.MAX_SAFE_INTEGER);
  }

  override buildFilterExpression(source: string, filter: FilterEmitInput): FilterTranslation {
    const emitted = emitBody(filter.body, { sourceParameter: filter.parameter, targetParameter: 'x', dialect: PYTHON_DIALECT });
    return {
      expression: `${HELPER_NAMESPACE}['__ec_dump'](list(filter(lambda x: ${emitted.text}, ${source})))`,
      exact: emitted.exact,
      notes: emitted.notes
    };
  }

  override buildRangeExpression(source: string, start: number, count: number): string {
    return `${HELPER_NAMESPACE}['__ec_dump'](__import__('itertools').islice(${source}, ${start}, ${start + count}))`;
  }

  override buildMemberExpression(source: string, path: readonly string[]): string {
    return path.reduce((accumulated, segment) => {
      if (/^\d+$/.test(segment)) {
        return `${accumulated}[${segment}]`;
      }
      if (/^[A-Za-z_]\w*$/.test(segment)) {
        return `${accumulated}.${segment}`;
      }
      return `${accumulated}[${JSON.stringify(segment)}]`;
    }, source);
  }
}
