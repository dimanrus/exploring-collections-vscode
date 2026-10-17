import { CSharpProvider, FSharpProvider } from './dotnetProvider';
import { JavaScriptProvider } from './javascriptProvider';
import { LanguageProviderRegistry } from './languageProvider';

export * from './languageProvider';
export * from './variablesWalk';
export * from './jsonPayload';
export * from './capturer';
export { CSharpProvider, FSharpProvider, JavaScriptProvider };

/**
 * Creates the registry with the bundled providers.
 *
 * The extension supports JavaScript/TypeScript, C# and F#. A provider that owns
 * the language of the file the debugger stopped in always wins over a provider
 * that only matches the debug type.
 */
export function createProviderRegistry(): LanguageProviderRegistry {
  const registry = new LanguageProviderRegistry();
  registry.register(new CSharpProvider());
  registry.register(new FSharpProvider());
  registry.register(new JavaScriptProvider());
  return registry;
}
