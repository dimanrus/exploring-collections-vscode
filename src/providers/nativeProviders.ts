import { AbstractLanguageProvider } from './baseProvider';
import type { LanguageId } from './languageProvider';

/**
 * Shared behaviour for the compiled languages. Their debug adapters expose
 * neither closures nor lambdas to the expression evaluator, so filtering always
 * happens on the client. Capture uses the universal `variables` walk unless the
 * user compiled the bundled native helper into the debuggee.
 */
abstract class NativeLanguageProvider extends AbstractLanguageProvider {
  /**
   * Expression that calls the native helper compiled into the debuggee, or
   * `undefined` when the provider cannot rely on one.
   */
  protected helperCall(_source: string): string | undefined {
    return undefined;
  }

  /** gdb/lldb slice syntax, used to verify the reported element count. */
  protected sliceExpression(source: string, start: number, count: number): string | undefined {
    return `${source}[${start}]@${count}`;
  }

  override buildNativeHelperExpression(source: string): string | undefined {
    return this.helperCall(source);
  }

  override buildRangeExpression(source: string, start: number, count: number): string | undefined {
    return this.sliceExpression(source, start, count);
  }

  override buildMemberExpression(source: string, path: readonly string[]): string {
    return path.reduce((accumulated, segment) => {
      if (/^\d+$/.test(segment)) {
        return `${accumulated}[${segment}]`;
      }
      if (/^\[\d+\]$/.test(segment)) {
        return `${accumulated}${segment}`;
      }
      if (/^[A-Za-z_]\w*$/.test(segment)) {
        return `${accumulated}.${segment}`;
      }
      return accumulated;
    }, source);
  }
}

/** Go provider. Delve evaluates indexing expressions but not arbitrary calls. */
export class GoProvider extends NativeLanguageProvider {
  override readonly id = 'go';
  override readonly language: LanguageId = 'go';
  override readonly displayName = 'Go';
  override readonly debugTypes = ['go', 'dlv', 'delve'];
  override readonly editorLanguages = ['go'];
  override readonly adapterHints = ['dlv-dap'];
  override readonly notes = [
    'Delve does not evaluate arbitrary function calls, so capture uses the universal variables walk.',
    'To use the JSON helper, add helpers/go/exploring_collections.go to your module and call exploringcollections.Dump(...) from the Debug Console (requires dlv call support).'
  ];
  // Delve is Go specific, so the provider wins on the debug type alone.
  override readonly debugTypePriority = 100;

  protected override helperCall(source: string): string | undefined {
    return `exploringcollections.Dump(${source})`;
  }

  protected override sliceExpression(source: string, start: number, count: number): string | undefined {
    return `${source}[${start}:${start + count}]`;
  }
}

/** Rust provider. CodeLLDB and rust-gdb evaluate indexing but not closures. */
export class RustProvider extends NativeLanguageProvider {
  override readonly id = 'rust';
  override readonly language: LanguageId = 'rust';
  override readonly displayName = 'Rust';
  override readonly debugTypes = ['lldb', 'rust', 'rust-gdb', 'code-lldb'];
  override readonly editorLanguages = ['rust'];
  override readonly adapterHints = ['codelldb', 'rust-gdb'];
  override readonly notes = [
    'Closures are unavailable to the expression evaluator, so filtering runs on the client.',
    'Include helpers/rust/exploring_collections.rs to enable exploring_collections::dump_json (lldb handles the call in the inferior process).',
    'Rust formats values with their Debug implementation, so a self referencing value must not be formatted (the standard library would recurse).'
  ];
  // `lldb` is CodeLLDB, which is used for Rust more often than for C++.
  override readonly debugTypePriority = 110;

  protected override helperCall(source: string): string | undefined {
    return `exploring_collections::dump_json(&${source})`;
  }

  protected override sliceExpression(source: string, start: number, count: number): string | undefined {
    return `${source}[${start}..${start + count}]`;
  }
}

/** Shared implementation of the C and C++ providers. */
abstract class CFamilyProvider extends NativeLanguageProvider {
  // CodeLLDB (`lldb`) is used for C and C++ as well as for Rust.
  protected override readonly compatibleDebugTypes = ['lldb'];

  protected override sliceExpression(source: string, start: number, count: number): string | undefined {
    // The gdb/lldb `expr[first]@count` operator slices arrays and raw pointers.
    return `${source}[${start}]@${count}`;
  }
}

/** C++ provider. */
export class CppProvider extends CFamilyProvider {
  override readonly id = 'cpp';
  override readonly language: LanguageId = 'cpp';
  override readonly displayName = 'C++';
  override readonly debugTypes = ['cppdbg', 'cppvsdbg', 'cppdbg-lldb'];
  override readonly editorLanguages = ['cpp', 'cuda-cpp'];
  override readonly adapterHints = ['cppdbg', 'cppvsdbg', 'MIEngine', 'codelldb'];
  override readonly notes = [
    'STL containers are enumerated through the variables walk; nested containers stay lazily expandable.',
    'Include helpers/cc/exploring_collections.h (C++17) to enable exploring_collections::dump_json_cstr, which also reports structs declared with EC_OBJECT.',
    'The native helper is used only when it is compiled into the debuggee; otherwise the variables walk runs instead.'
  ];

  protected override helperCall(source: string): string | undefined {
    // The `_cstr` variant returns a `const char*`, which debuggers print as a
    // quoted string; the std::string variant would show its internals.
    return `exploring_collections::dump_json_cstr(${source})`;
  }
}

/** C provider. */
export class CProvider extends CFamilyProvider {
  override readonly id = 'c';
  override readonly language: LanguageId = 'c';
  override readonly displayName = 'C';
  override readonly debugTypes = ['cppdbg', 'cppvsdbg', 'cppdbg-lldb'];
  override readonly editorLanguages = ['c'];
  override readonly adapterHints = ['cppdbg', 'cppvsdbg', 'MIEngine'];
  override readonly notes = [
    'Arrays and pointer ranges are read with the gdb `expr[first]@count` operator when the adapter supports it.',
    'helpers/cc/exploring_collections.h exposes a descriptor based C API: call exploring_collections_dump_structs(base, count, stride, fields, fieldCount) from the Debug Console to inspect struct arrays.'
  ];
  // `cppdbg` serves C and C++ alike; C++ wins unless a C file is focused.
  override readonly debugTypePriority = 90;

  // The C API needs a field descriptor table, so there is no single argument
  // expression the extension could generate on its own.
  protected override helperCall(): string | undefined {
    return undefined;
  }
}
