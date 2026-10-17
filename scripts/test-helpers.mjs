#!/usr/bin/env node
/**
 * Runs the self tests of every bundled helper.
 *
 * The .NET helper has its own test suite so it can be verified without the
 * editor. A missing toolchain is reported as skipped rather than failing the run.
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
