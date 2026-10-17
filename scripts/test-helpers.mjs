#!/usr/bin/env node
/**
 * Runs the self tests of every bundled helper.
 *
 * Each helper has its own test suite so it can be verified without the editor:
 *   .NET     -> helpers/dotnet/tests            (dotnet)
 *   Python   -> helpers/python/test_helper.py   (python3)
 *   Go       -> helpers/go                      (go test)
 *   Rust     -> helpers/rust                    (cargo test)
 *   C/C++    -> helpers/cc/build_and_test.sh    (gcc/g++)
 *
 * A missing toolchain is reported as skipped rather than failing the run, so the
 * script is usable on machines that only have some of the languages installed.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function has(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  if (result.error) {
    // Some tools only expose a different flag, but a spawn error means missing.
    const fallback = spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return fallback.status === 0;
  }
  return true;
}

const suites = [
  {
    name: '.NET (C#/F#) helper',
    tool: 'dotnet',
    command: 'dotnet',
    args: ['run', '-c', 'Release', '--nologo'],
    cwd: resolve(root, 'helpers/dotnet/tests')
  },
  {
    name: 'Python helper',
    tool: 'python3',
    command: 'python3',
    args: ['helpers/python/test_helper.py'],
    cwd: root
  },
  {
    name: 'Go helper',
    tool: 'go',
    command: 'go',
    args: ['test', './...'],
    cwd: resolve(root, 'helpers/go')
  },
  {
    name: 'Rust helper',
    tool: 'cargo',
    command: 'cargo',
    args: ['test', '--offline'],
    cwd: resolve(root, 'helpers/rust')
  },
  {
    name: 'C/C++ helper',
    tool: 'bash',
    command: 'bash',
    args: ['helpers/cc/build_and_test.sh'],
    cwd: root
  }
];

const only = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
const results = [];
let failed = 0;

for (const suite of suites) {
  if (only.length > 0 && !only.some((filter) => suite.name.toLowerCase().includes(filter.toLowerCase()))) {
    continue;
  }
  if (!has(suite.tool)) {
    results.push({ name: suite.name, status: 'skipped', detail: `${suite.tool} is not installed` });
    continue;
  }

  process.stdout.write(`\n=== ${suite.name} ===\n`);
  const result = spawnSync(suite.command, suite.args, {
    cwd: suite.cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status === 0) {
    results.push({ name: suite.name, status: 'ok' });
  } else {
    failed += 1;
    results.push({ name: suite.name, status: 'failed', detail: `exit code ${result.status}` });
  }
}

console.log('\n=== helper test summary ===');
for (const entry of results) {
  const icon = entry.status === 'ok' ? 'PASS' : entry.status === 'skipped' ? 'SKIP' : 'FAIL';
  console.log(`  ${icon}  ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
}

const skipped = results.filter((entry) => entry.status === 'skipped').length;
if (failed > 0) {
  console.log(`\n${failed} helper suite(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${results.length - skipped} available helper suite(s) passed${skipped > 0 ? `, ${skipped} skipped` : ''}.`);
}
