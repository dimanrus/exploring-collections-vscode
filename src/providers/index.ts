import { CSharpProvider, FSharpProvider } from './dotnetProvider';
import { JavaScriptProvider } from './javascriptProvider';
import { PythonProvider } from './pythonProvider';
import { CProvider, CppProvider, GoProvider, RustProvider } from './nativeProviders';
import { LanguageProviderRegistry } from './languageProvider';

export * from './languageProvider';
export * from './variablesWalk';
export * from './jsonPayload';
export * from './capturer';
export { CSharpProvider, FSharpProvider, JavaScriptProvider, PythonProvider, CProvider, CppProvider, GoProvider, RustProvider };

/**
 * Creates the registry with all bundled providers.
 *
 * Order matters only for ties: a provider that owns the language of the file the
 * debugger stopped in always wins over a provider that only matches the debug
 * type, so shared adapters (cppdbg for C and C++, lldb for Rust and C++) are
 * resolved correctly.
 */
export function createProviderRegistry(): LanguageProviderRegistry {
  const registry = new LanguageProviderRegistry();
  registry.register(new CSharpProvider());
  registry.register(new FSharpProvider());
  registry.register(new JavaScriptProvider());
  registry.register(new PythonProvider());
  registry.register(new RustProvider());
  registry.register(new CppProvider());
  registry.register(new CProvider());
  registry.register(new GoProvider());
  return registry;
}
