import type { ElementNode } from '../model/snapshotBuilder';
import { emitBody } from '../filter/emit';
import { JAVASCRIPT_DIALECT } from '../filter/dialects';
import { AbstractLanguageProvider, quoteForSource } from './baseProvider';
import { elementsFromPayload } from './jsonPayload';
import type { FilterEmitInput, FilterTranslation, HelperOptions, LanguageId } from './languageProvider';

/** Debug types owned by the JavaScript debug adapters (js-debug, Chrome, Node). */
export const JS_DEBUG_TYPES = [
  'node',
  'pwa-node',
  'node-terminal',
  'extensionHost',
  'chrome',
  'msedge',
  'pwa-chrome',
  'pwa-msedge',
  'js-debug'
] as const;

/** Hard cap inside the generated serializer, to keep DAP payloads sane. */
const SERIALIZER_CAP = 200000;

/**
 * Builds a self contained JavaScript expression that serializes the collection
 * into the helper envelope. The expression is an IIFE, so it can be dropped
 * into any frame context without polluting the debuggee's scope.
 */
export function buildJavaScriptSerializer(source: string, depth: number, maxItems: number): string {
  const cap = Math.max(1, Math.min(SERIALIZER_CAP, maxItems));
  const statements = [
    'const M=' + cap,
    'const D=' + Math.max(1, Math.min(12, depth)),
    'const seen=new Set()',
    'const names=(v)=>{const s=new Set();for(const k of Object.keys(v))s.add(k);let p=Object.getPrototypeOf(v);let g=0;while(p&&p!==Object.prototype&&p!==Array.prototype&&g++<8){for(const k of Object.getOwnPropertyNames(p)){if(k!=="constructor")s.add(k)}p=Object.getPrototypeOf(p)}return s}',
    'const enc=(v,d)=>{' +
      'if(v===null)return null;' +
      'const t=typeof v;' +
      'if(t==="undefined")return null;' +
      'if(t==="bigint")return v.toString();' +
      'if(t==="number")return Number.isFinite(v)?v:String(v);' +
      'if(t==="string"||t==="boolean")return v;' +
      'if(t==="function")return "[Function "+(v.name||"anonymous")+"]";' +
      'if(t==="symbol")return v.toString();' +
      'if(v instanceof Date)return isNaN(+v)?"[Invalid Date]":v.toISOString();' +
      'if(v instanceof RegExp)return v.toString();' +
      'if(v instanceof Error)return {name:v.name,message:v.message};' +
      'if(typeof ArrayBuffer!=="undefined"&&ArrayBuffer.isView&&ArrayBuffer.isView(v))return Array.prototype.slice.call(v);' +
      'if(typeof v.toJSON==="function"){try{const j=v.toJSON();if(j!==v)return enc(j,d)}catch(e){}}' +
      'if(d<=0)return Array.isArray(v)?"[Array("+v.length+")]":(v instanceof Map?"[Map("+v.size+")]":(v instanceof Set?"[Set("+v.size+")]":"[Object]"));' +
      'if(seen.has(v))return "[Circular]";' +
      'seen.add(v);' +
      'let r;' +
      'if(v instanceof Map){r={};let i=0;for(const e of v){r[String(e[0])]=enc(e[1],d-1);if(++i>=M)break}}' +
      'else if(v instanceof Set){r=[];let i=0;for(const e of v){r.push(enc(e,d-1));if(++i>=M)break}}' +
      'else if(Array.isArray(v)){r=[];const n=Math.min(v.length,M);for(let i=0;i<n;i++)r.push(enc(v[i],d-1))}' +
      'else{r={};for(const k of names(v)){let cv;try{cv=v[k]}catch(e){r[k]="[Thrown: "+((e&&e.message)||e)+"]";continue}if(typeof cv==="function")continue;r[k]=enc(cv,d-1)}}' +
      'seen.delete(v);return r}',
    'const R=' + source,
    'const isMap=R instanceof Map',
    'const isSeq=Array.isArray(R)||R instanceof Set||isMap',
    'const total=isSeq?(isMap||R instanceof Set?R.size:R.length):null',
    'const kind=isMap?"mapping":(isSeq?"sequence":"record")',
    'let items',
    // One statement, because the statements are joined with `;` and a semicolon
    // between `if (...) {}` and `else if` would be a syntax error in the debuggee.
    'if(isMap){items=[];let i=0;for(const e of R){items.push([enc(e[0],1),enc(e[1],D)]);if(++i>=M)break}}' +
      'else if(isSeq){items=enc(R,D)}' +
      'else{items=[enc(R,D)]}',
    'return JSON.stringify({__ec:1,kind:kind,total:total,items:items})'
  ];
  return `(()=>{${statements.join(';')}})()`;
}

/** JavaScript / TypeScript provider, shared by js-debug, Chrome and Node. */
export class JavaScriptProvider extends AbstractLanguageProvider {
  override readonly id = 'javascript';
  override readonly language: LanguageId = 'javascript';
  override readonly displayName = 'JavaScript / TypeScript';
  override readonly debugTypes = JS_DEBUG_TYPES;
  override readonly editorLanguages = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'];
  override readonly adapterHints = ['js-debug', 'vscode-chrome-debug', 'vscode-node-debug2'];
  override readonly notes = [
    'Collections are serialized by an injected IIFE, so Map, Set, typed arrays and getters are reported accurately.',
    'Expressions run in the frame context and can reference any local variable of the current statement.'
  ];

  protected override get handledLanguages(): readonly LanguageId[] {
    return ['javascript', 'typescript'];
  }

  override buildSerializeExpression(source: string, options: HelperOptions): string[] {
    return [buildJavaScriptSerializer(source, options.depth, 100000)];
  }

  override parseSerializedPayload(payload: string): ElementNode[] | undefined {
    return elementsFromPayload(payload, Number.MAX_SAFE_INTEGER);
  }

  override buildFilterExpression(source: string, filter: FilterEmitInput): FilterTranslation {
    const emitted = emitBody(filter.body, { sourceParameter: filter.parameter, targetParameter: 'x', dialect: JAVASCRIPT_DIALECT });
    return {
      expression: buildJavaScriptSerializer(`(${source}).filter(x => ${emitted.text})`, 6, 100000),
      exact: emitted.exact,
      notes: emitted.notes
    };
  }

  override buildRangeExpression(source: string, start: number, count: number): string {
    return buildJavaScriptSerializer(`Array.prototype.slice.call(${source}, ${start}, ${start + count})`, 6, count);
  }

  override buildMemberExpression(source: string, path: readonly string[]): string {
    return path.reduce((accumulated, segment) => {
      if (/^\d+$/.test(segment)) {
        return `${accumulated}[${segment}]`;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(segment)) {
        return `${accumulated}.${segment}`;
      }
      return `${accumulated}[${quoteForSource(segment)}]`;
    }, source);
  }
}
