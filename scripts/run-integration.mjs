import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * Runs the integration suite inside a real Visual Studio Code instance.
 *
 * The user data and extension directories live in a temporary folder, so the
 * developer's own VS Code profile, extensions and settings are never touched.
 * Built in extensions (including js-debug, which the suite debugs with) still
 * come from the VS Code installation.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = join(tmpdir(), 'exploring-collections-integration');
const profile = join(tmpdir(), 'exploring-collections-vscode-profile');

const SAMPLE = `const cities = ['Seoul', 'Sofia', 'Lima'];

function buildTemperatures() {
  return cities.flatMap((city, index) =>
    [0, 1, 2, 3].map((day) => ({
      city,
      day,
      degree: 5 + ((index * 4 + day) % 25)
    }))
  );
}

function main() {
  const temperatures = buildTemperatures();
  const lookup = { cityCount: cities.length, sampleCount: temperatures.length };
  // A collection the variables walk cannot afford to read element by element.
  const employees = Array.from({ length: 50000 }, (_, id) => ({
    id,
    name: 'Emp' + id,
    salary: 10 + (id % 80),
    department: 'IT'
  }));
  console.log(temperatures.length, lookup.cityCount, employees.length);
  return temperatures;
}

main();
`;

const FIXTURE = `// Hardcoded data: the design time preview must open it without a debug session.
const readings = [
  { city: 'Seoul', degrees: 21 },
  { city: 'Busan', degrees: 24 }
];

module.exports = { readings };
`;

function findExecutable() {
  const candidates = [
    process.env.VSCODE_EXECUTABLE_PATH,
    '/usr/share/code/code',
    '/usr/bin/code',
    '/snap/bin/code',
    '/opt/visual-studio-code/code'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Visual Studio Code was not found. Looked at: ${candidates.join(', ')}. ` +
      'Set VSCODE_EXECUTABLE_PATH to run the integration suite.'
  );
}

function prepare() {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, '.vscode'), { recursive: true });
  writeFileSync(join(workspace, 'main.js'), SAMPLE, 'utf8');
  writeFileSync(join(workspace, 'fixture.js'), FIXTURE, 'utf8');
  writeFileSync(join(workspace, 'README.md'), '# integration workspace\n', 'utf8');
  mkdirSync(profile, { recursive: true });
}

function run() {
  const executable = findExecutable();
  const args = [
    // A throwaway profile keeps the developer's VS Code untouched.
    `--user-data-dir=${profile}`,
    `--extensions-dir=${join(profile, 'extensions')}`,
    '--disable-workspace-trust',
    '--disable-gpu',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-sandbox',
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${join(root, 'out', 'integration', 'index.js')}`,
    workspace
  ];

  const verbose = process.argv.includes('--verbose');
  console.log(`launching ${executable} for the integration suite...`);
  const child = spawn(executable, args, {
    // VS Code is extremely chatty, so its output is filtered down to the lines
    // that belong to the suite unless `--verbose` is passed.
    stdio: ['ignore', verbose ? 'inherit' : 'pipe', verbose ? 'inherit' : 'pipe'],
    env: { ...process.env, VSCODE_DISABLE_TELEMETRY: '1' }
  });

  const forward = (stream, sink) => {
    if (!stream) {
      return;
    }
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (
          /PASS|FAIL|integration|Error|error: |not found|could not|timed out|must /.test(line) &&
          !/No signed-in session|AgentHost|DeprecationWarning/.test(line)
        ) {
          sink(line);
        }
      }
    });
  };
  forward(child.stdout, (line) => console.log(line));
  forward(child.stderr, (line) => console.error(line));

  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', (error) => {
      console.error(`could not launch VS Code: ${error.message}`);
      resolve(1);
    });
  });
}

prepare();
const code = await run();
console.log(code === 0 ? 'integration suite passed' : `integration suite failed (exit ${code})`);
process.exit(code);
