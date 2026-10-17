import type { EmitDialect } from './emit';

/**
 * Per language rendering of the canonical filter AST. Keeping the dialects in
 * one place makes the differences reviewable and unit testable.
 */

function lower(value: string): string {
  return value.toLowerCase();
}

/** C# / F# expression dialect, used for debugger side pushdown. */
export const CSHARP_DIALECT: EmitDialect = {
  equality: '==',
  inequality: '!=',
  and: '&&',
  or: '||',
  not: '!',
  nullLiteral: 'null',
  booleanLiteral: (value) => (value ? 'true' : 'false'),
  unsupported: new Set(['in', 'like', 'ilike']),
  method: (receiver, name, args) => {
    switch (lower(name)) {
      case 'tolower':
      case 'tolowercase':
        return `${receiver}.ToLower()`;
      case 'toupper':
      case 'touppercase':
        return `${receiver}.ToUpper()`;
      case 'trim':
        return `${receiver}.Trim()`;
      case 'contains':
      case 'includes':
        return `${receiver}.Contains(${args[0]})`;
      case 'startswith':
        return `${receiver}.StartsWith(${args[0]})`;
      case 'endswith':
        return `${receiver}.EndsWith(${args[0]})`;
      case 'indexof':
        return `${receiver}.IndexOf(${args[0]})`;
      case 'substring':
      case 'substr':
      case 'slice':
        return `${receiver}.Substring(${args.join(', ')})`;
      case 'length':
      case 'count':
        return `System.Linq.Enumerable.Count(${receiver})`;
      case 'any':
        return `System.Linq.Enumerable.Any(${receiver})`;
      case 'tostring':
        return `${receiver}.ToString()`;
      default:
        return undefined;
    }
  },
  call: (name, args) => {
    switch (lower(name)) {
      case 'isnull':
        return `(${args[0]} == null)`;
      case 'isnotnull':
        return `(${args[0]} != null)`;
      case 'isempty':
        return `(System.Linq.Enumerable.Count(${args[0]}) == 0)`;
      case 'len':
      case 'length':
      case 'count':
        return `System.Linq.Enumerable.Count(${args[0]})`;
      case 'lower':
      case 'lowercase':
        return `${args[0]}.ToLower()`;
      case 'upper':
      case 'uppercase':
        return `${args[0]}.ToUpper()`;
      case 'trim':
        return `${args[0]}.Trim()`;
      case 'contains':
        return `${args[0]}.Contains(${args[1]})`;
      case 'startswith':
        return `${args[0]}.StartsWith(${args[1]})`;
      case 'endswith':
        return `${args[0]}.EndsWith(${args[1]})`;
      case 'abs':
        return `System.Math.Abs(${args[0]})`;
      case 'round':
        return `System.Math.Round(${args.join(', ')})`;
      case 'floor':
        return `System.Math.Floor(${args[0]})`;
      case 'ceil':
        return `System.Math.Ceiling(${args[0]})`;
      case 'sqrt':
        return `System.Math.Sqrt(${args[0]})`;
      case 'pow':
        return `System.Math.Pow(${args.join(', ')})`;
      case 'year':
        return `${args[0]}.Year`;
      case 'month':
        return `${args[0]}.Month`;
      case 'day':
        return `${args[0]}.Day`;
      case 'string':
        return `${args[0]}.ToString()`;
      default:
        return undefined;
    }
  }
};

/** F# dialect: `=` for equality, `Seq` for sequence operations. */
export const FSHARP_DIALECT: EmitDialect = {
  equality: '=',
  inequality: '<>',
  and: '&&',
  or: '||',
  not: 'not ',
  nullLiteral: 'null',
  booleanLiteral: (value) => (value ? 'true' : 'false'),
  unsupported: new Set(['in', 'like', 'ilike']),
  method: (receiver, name, args) => {
    switch (lower(name)) {
      case 'tolower':
      case 'tolowercase':
        return `${receiver}.ToLower()`;
      case 'toupper':
      case 'touppercase':
        return `${receiver}.ToUpper()`;
      case 'trim':
        return `${receiver}.Trim()`;
      case 'contains':
      case 'includes':
        return `${receiver}.Contains(${args[0]})`;
      case 'startswith':
        return `${receiver}.StartsWith(${args[0]})`;
      case 'endswith':
        return `${receiver}.EndsWith(${args[0]})`;
      case 'indexof':
        return `${receiver}.IndexOf(${args[0]})`;
      case 'length':
      case 'count':
        return `Seq.length (${receiver})`;
      case 'any':
        return `Seq.isEmpty (${receiver}) |> not`;
      case 'tostring':
        return `${receiver}.ToString()`;
      default:
        return undefined;
    }
  },
  call: (name, args) => {
    switch (lower(name)) {
      case 'isnull':
        return `isNull (${args[0]})`;
      case 'isnotnull':
        return `not (isNull (${args[0]}))`;
      case 'isempty':
        return `(Seq.length (${args[0]}) = 0)`;
      case 'len':
      case 'length':
      case 'count':
        return `Seq.length (${args[0]})`;
      case 'lower':
      case 'lowercase':
        return `${args[0]}.ToLower()`;
      case 'upper':
      case 'uppercase':
        return `${args[0]}.ToUpper()`;
      case 'trim':
        return `${args[0]}.Trim()`;
      case 'contains':
        return `${args[0]}.Contains(${args[1]})`;
      case 'startswith':
        return `${args[0]}.StartsWith(${args[1]})`;
      case 'endswith':
        return `${args[0]}.EndsWith(${args[1]})`;
      case 'abs':
        return `abs (${args[0]})`;
      case 'floor':
        return `floor (${args[0]})`;
      case 'ceil':
        return `ceil (${args[0]})`;
      case 'sqrt':
        return `sqrt (${args[0]})`;
      default:
        return undefined;
    }
  }
};

/** JavaScript / TypeScript dialect. */
export const JAVASCRIPT_DIALECT: EmitDialect = {
  equality: '===',
  inequality: '!==',
  and: '&&',
  or: '||',
  not: '!',
  nullLiteral: 'null',
  booleanLiteral: (value) => (value ? 'true' : 'false'),
  method: (receiver, name, args) => {
    switch (lower(name)) {
      case 'tolower':
      case 'tolowercase':
        return `${receiver}.toLowerCase()`;
      case 'toupper':
      case 'touppercase':
        return `${receiver}.toUpperCase()`;
      case 'trim':
        return `${receiver}.trim()`;
      case 'contains':
      case 'includes':
        return `${receiver}.includes(${args[0]})`;
      case 'startswith':
        return `${receiver}.startsWith(${args[0]})`;
      case 'endswith':
        return `${receiver}.endsWith(${args[0]})`;
      case 'indexof':
        return `${receiver}.indexOf(${args[0]})`;
      case 'substring':
      case 'substr':
      case 'slice':
        return `${receiver}.slice(${args.join(', ')})`;
      case 'length':
      case 'count':
        return `${receiver}.length`;
      case 'any':
        return `(${receiver}.length > 0)`;
      case 'tostring':
        return `String(${receiver})`;
      default:
        return undefined;
    }
  },
  call: (name, args) => {
    switch (lower(name)) {
      case 'isnull':
        return `(${args[0]} === null || ${args[0]} === undefined)`;
      case 'isnotnull':
        return `(${args[0]} !== null && ${args[0]} !== undefined)`;
      case 'isempty':
        return `(${args[0]}.length === 0)`;
      case 'len':
      case 'length':
      case 'count':
        return `${args[0]}.length`;
      case 'lower':
      case 'lowercase':
        return `${args[0]}.toLowerCase()`;
      case 'upper':
      case 'uppercase':
        return `${args[0]}.toUpperCase()`;
      case 'trim':
        return `${args[0]}.trim()`;
      case 'contains':
        return `${args[0]}.includes(${args[1]})`;
      case 'startswith':
        return `${args[0]}.startsWith(${args[1]})`;
      case 'endswith':
        return `${args[0]}.endsWith(${args[1]})`;
      case 'abs':
        return `Math.abs(${args[0]})`;
      case 'round':
        return `Math.round(${args.join(', ')})`;
      case 'floor':
        return `Math.floor(${args[0]})`;
      case 'ceil':
        return `Math.ceil(${args[0]})`;
      case 'sqrt':
        return `Math.sqrt(${args[0]})`;
      case 'pow':
        return `Math.pow(${args.join(', ')})`;
      case 'year':
        return `new Date(${args[0]}).getFullYear()`;
      case 'month':
        return `(new Date(${args[0]}).getMonth() + 1)`;
      case 'day':
        return `new Date(${args[0]}).getDate()`;
      case 'string':
        return `String(${args[0]})`;
      case 'matches':
        return `new RegExp(${args[1]}).test(${args[0]})`;
      default:
        return undefined;
    }
  }
};
