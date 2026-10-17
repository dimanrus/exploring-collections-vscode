import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DapClient } from '../src/debug/dapClient';
import { silentLogger } from '../src/util/logging';

const dapOptions = { timeoutMs: 1000 };

describe('DapClient.tryEvaluate', () => {
  it('reports a failed evaluation that the adapter hid in a successful response', async () => {
    const client = new DapClient(
      async () => ({
        result:
          "'System.Reflection.Assembly.LoadFrom(\"/tmp/missing.dll\")' threw an exception of type 'System.IO.FileNotFoundException'",
        type: 'System.Reflection.Assembly {System.IO.FileNotFoundException}',
        variablesReference: 0,
        presentationHint: { kind: 'method', attributes: ['failedEvaluation'] }
      }),
      silentLogger,
      'session'
    );

    const outcome = await client.tryEvaluate('Assembly.LoadFrom(...)', 1, 'watch', dapOptions);
    assert.equal(outcome.ok, false);
    assert.match((outcome as { error: Error }).error.message, /FileNotFoundException/);
  });

  it('keeps a normal evaluation successful', async () => {
    const client = new DapClient(
      async () => ({
        result: '{ExploringCollections.Helper}',
        type: 'System.Reflection.Assembly',
        variablesReference: 0,
        presentationHint: { kind: 'method', attributes: ['readOnly'] }
      }),
      silentLogger,
      'session'
    );

    const outcome = await client.tryEvaluate('Assembly.LoadFrom(...)', 1, 'watch', dapOptions);
    assert.equal(outcome.ok, true);
    assert.equal((outcome as { value: { result: string } }).value.result, '{ExploringCollections.Helper}');
  });
});
