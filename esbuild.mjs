import { context, build } from 'esbuild';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const testsOnly = args.has('--tests');
const integrationOnly = args.has('--integration');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development')
  }
};

function extensionBuild() {
  return {
    ...shared,
    entryPoints: [join(root, 'src/extension.ts')],
    outfile: join(root, 'dist/extension.js'),
    format: 'cjs',
    external: ['vscode']
  };
}

function webviewBuild() {
  return {
    ...shared,
    entryPoints: [join(root, 'webview/main.ts')],
    outfile: join(root, 'dist/webview.js'),
    format: 'iife',
    target: 'es2022'
  };
}

function testBuild() {
  const testDir = join(root, 'test');
  if (!existsSync(testDir)) {
    return undefined;
  }
  const entryPoints = readdirSync(testDir)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => join(testDir, name));
  if (entryPoints.length === 0) {
    return undefined;
  }
  return {
    ...shared,
    minify: false,
    sourcemap: 'inline',
    entryPoints,
    outdir: join(root, 'out/test'),
    outExtension: { '.js': '.test.js' },
    format: 'cjs',
    // `jsdom` resolves its own internals dynamically, so it stays external and is
    // required from node_modules at runtime.
    external: ['vscode', 'jsdom']
  };
}

/** Bundle that VS Code loads as the test host entry point. */
function integrationBuild() {
  return {
    ...shared,
    entryPoints: [join(root, 'test/integration/index.ts')],
    outfile: join(root, 'out/integration/index.js'),
    format: 'cjs',
    minify: false,
    external: ['vscode']
  };
}

async function main() {
  const configs = [];
  if (integrationOnly) {
    configs.push(integrationBuild());
  } else if (!testsOnly) {
    configs.push(extensionBuild(), webviewBuild());
  } else {
    const config = testBuild();
    if (config) {
      rmSync(join(root, 'out/test'), { recursive: true, force: true });
      mkdirSync(join(root, 'out/test'), { recursive: true });
      configs.push(config);
    }
  }

  if (configs.length === 0) {
    console.log('nothing to build');
    return;
  }

  if (watch) {
    const contexts = await Promise.all(configs.map((config) => context(config)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('watching for changes...');
    return;
  }

  await Promise.all(configs.map((config) => build(config)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
