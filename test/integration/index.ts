import * as assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

/**
 * Integration suite that runs inside a real Visual Studio Code instance.
 *
 * It starts a real Node debug session, stops on a breakpoint that has a list and
 * a dictionary in scope, and then drives the extension exactly like a user does:
 * through the CodeLens, the hover link and the panel each of them opens.
 */

interface Result {
  name: string;
  ok: boolean;
  error?: string;
}

interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
}

const results: Result[] = [];

async function test(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({
      name,
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error)
    });
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitFor<T>(
  description: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 30000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The active stack item can be the thread rather than a frame, and a thread has
 * no `frameId`, so the top frame is asked for over DAP directly.
 */
async function topFrameId(session: vscode.DebugSession): Promise<number> {
  const item = vscode.debug.activeStackItem;
  if (item && 'frameId' in item) {
    return (item as vscode.DebugStackFrame).frameId;
  }
  const threads = await session.customRequest('threads');
  for (const thread of threads?.threads ?? []) {
    const trace = await session.customRequest('stackTrace', { threadId: thread.id, levels: 1 });
    const frame = trace?.stackFrames?.[0];
    if (frame) {
      return frame.id as number;
    }
  }
  throw new Error('the debug adapter reported no stack frame');
}

async function frameVariables(session: vscode.DebugSession, frameId: number): Promise<DebugVariable[]> {
  const scopes = await session.customRequest('scopes', { frameId });
  const found: DebugVariable[] = [];
  for (const scope of scopes?.scopes ?? []) {
    const response = await session.customRequest('variables', {
      variablesReference: scope.variablesReference
    });
    found.push(...((response?.variables ?? []) as DebugVariable[]));
  }
  return found;
}

function exploreLenses(lenses: readonly vscode.CodeLens[] | undefined): vscode.CodeLens[] {
  return (lenses ?? []).filter((lens) => lens.command?.command === 'exploringCollections.explore');
}

/**
 * Nudges the document so the editor recomputes its language features. Real users
 * get this from the extension's `onDidChangeCodeLenses` events; a headless run
 * has to ask for it explicitly.
 */
async function touch(uri: vscode.Uri, line: number): Promise<void> {
  const insert = new vscode.WorkspaceEdit();
  insert.insert(uri, new vscode.Position(line, 0), ' ');
  await vscode.workspace.applyEdit(insert);
  const remove = new vscode.WorkspaceEdit();
  remove.delete(uri, new vscode.Range(line, 0, line, 1));
  await vscode.workspace.applyEdit(remove);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function webviewTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('dimanrus.exploring-collections');
  const folder = vscode.workspace.workspaceFolders?.[0];

  await test('the extension is installed and activates', async () => {
    assert.ok(extension, 'the development extension must be loaded');
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  assert.ok(folder, 'the integration run needs a workspace folder');
  const program = vscode.Uri.joinPath(folder.uri, 'main.js');

  await test('hardcoded data is previewed without a debug session', async () => {
    assert.equal(vscode.debug.activeDebugSession, undefined, 'this check runs outside debugging');

    const fixture = vscode.Uri.joinPath(folder.uri, 'fixture.js');
    const fixtureDocument = await vscode.workspace.openTextDocument(fixture);
    await vscode.window.showTextDocument(fixtureDocument);
    const declaration = fixtureDocument
      .getText()
      .split('\n')
      .findIndex((line) => line.includes('const readings'));

    const lenses = await waitFor(
      'the Preview data CodeLens',
      async () => {
        await touch(fixture, declaration);
        const found = (
          await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider',
            fixture
          )
        )?.filter((lens) => lens.command?.command === 'exploringCollections.previewLiteral');
        return found && found.length > 0 ? found : undefined;
      },
      20000
    );

    assert.equal(lenses.length, 1, 'one literal, one lens');
    assert.equal(lenses[0]?.range.start.line, declaration, 'the lens sits on the declaration');
    assert.match(lenses[0]?.command?.title ?? '', /readings/u);

    const before = webviewTabs().length;
    await vscode.commands.executeCommand(
      'exploringCollections.previewLiteral',
      lenses[0]?.command?.arguments?.[0]
    );
    const tabs = await waitFor('the viewer of the literal', () => {
      const opened = webviewTabs();
      return opened.length > before ? opened : undefined;
    });
    assert.match(
      (tabs[tabs.length - 1] as vscode.Tab).label,
      /readings/u,
      'the panel must be titled after the literal'
    );

    // The panel must hold the rows of the literal, not an empty capture.
    await vscode.commands.executeCommand('exploringCollections.showDiagnostics');
    const report = vscode.window.activeTextEditor?.document;
    assert.ok(report, 'the diagnostics report must open');
    const text = report.getText();
    assert.match(text, /### readings/u, 'the literal must be the current snapshot');
    assert.match(text, /Read from the source text/u, 'the snapshot must say where it came from');

    // Refresh re-reads the document instead of asking a debugger for the data.
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('exploringCollections.refresh');
    });
  });
  const document = await vscode.workspace.openTextDocument(program);
  const lines = document.getText().split('\n');
  const stopAt = lines.findIndex((line) => line.includes('console.log(temperatures.length'));
  assert.ok(stopAt > 0, 'the sample program must contain the stop marker');

  try {
    await test('a real Node debug session stops on the breakpoint', async () => {
      vscode.debug.addBreakpoints([
        new vscode.SourceBreakpoint(new vscode.Location(program, new vscode.Position(stopAt, 0)))
      ]);
      await vscode.window.showTextDocument(document);

      const started = await vscode.debug.startDebugging(folder, {
        type: 'pwa-node',
        name: 'Exploring Collections integration',
        request: 'launch',
        program: program.fsPath,
        console: 'internalConsole',
        stopOnEntry: false,
        skipFiles: ['<node_internals>/**']
      });
      assert.equal(started, true, 'the debug session must start');

      await waitFor('the debugger to stop', () => vscode.debug.activeStackItem ?? undefined);
      assert.ok(vscode.debug.activeDebugSession, 'a debug session must be active');
    });

    const session = vscode.debug.activeDebugSession as vscode.DebugSession;
    const frameId = await waitFor('a stack frame', async () => {
      try {
        return await topFrameId(session);
      } catch {
        return undefined;
      }
    });
    const variables = await frameVariables(session, frameId);

    await test('the stopped frame reports the collections of the program', () => {
      const names = variables.map((variable) => variable.name);
      assert.ok(names.includes('temperatures'), `temperatures must be in scope, saw: ${names.join(', ')}`);
      assert.ok(names.includes('lookup'), `lookup must be in scope, saw: ${names.join(', ')}`);
    });

    await test('the diagnostics report lists the collections of the frame', async () => {
      await vscode.commands.executeCommand('exploringCollections.showDiagnostics');
      const report = vscode.window.activeTextEditor?.document;
      assert.ok(report, 'the diagnostics report must open in an editor');
      const text = report.getText();
      // Written out so the report can be inspected after the run.
      writeFileSync(join(tmpdir(), 'exploring-collections-diagnostics.md'), text, 'utf8');
      assert.ok(text.includes('Collections in the current frame'), 'the report must carry the new section');
      assert.ok(text.includes('temperatures'), 'the frame collections must be listed in the report');

      // The CodeLens section explains a missing lens: it names the line each
      // lens is attached to and how that line was chosen.
      assert.ok(text.includes('Explore code lens'), 'the report must carry the CodeLens section');
      assert.ok(text.includes('editor.codeLens'), 'the report must show the editor setting');
      const lensLines = text
        .split('\n')
        .filter((line) => line.startsWith('| temperatures'))
        .map((line) => line.split('|')[3]?.trim());
      assert.ok(lensLines.length > 0, 'the lens table must have a row per collection');
      assert.ok(
        lensLines.some((line) => line !== undefined && /^\d+$/u.test(line)),
        `the lens table must report a line number: ${lensLines.join(', ')}`
      );

      // Reading it is enough: the report must not steal the editor from the file
      // the debugger stopped in, because CodeLens is only computed for visible
      // editors.
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.window.showTextDocument(document);
    });

    await test('an Explore CodeLens is offered for every collection in scope', async () => {
      await vscode.window.showTextDocument(document);
      await touch(program, stopAt);

      // Language features are debounced and cached per document, so the lenses
      // are polled for instead of demanded once.
      const lenses = await waitFor(
        'the Explore CodeLens',
        async () => {
          const found = exploreLenses(
            await vscode.commands.executeCommand<vscode.CodeLens[]>(
              'vscode.executeCodeLensProvider',
              program
            )
          );
          return found.length > 0 ? found : undefined;
        },
        20000
      );

      assert.ok(lenses.length >= 2, `expected a lens per collection, got ${lenses.length}`);
      const titles = lenses.map((lens) => lens.command?.title ?? '');
      assert.ok(
        titles.some((title) => title.includes('temperatures')),
        `a lens must name the collection: ${titles.join(' | ')}`
      );

      console.log(
        `      diagnostics: language=${document.languageId} uri=${document.uri.toString()} ` +
          `stackItem=${vscode.debug.activeStackItem ? 'present' : 'none'} lenses=${lenses.length}`
      );
      const lensLines = lenses.map((lens) => lens.range.start.line);
      assert.equal(
        new Set(lensLines).size,
        lensLines.length,
        `no two collections may share a lens line: ${lensLines.join(', ')}`
      );
      assert.ok(lensLines.every((line) => line <= stopAt), 'the lenses belong at or above the breakpoint');

      const temperatures = lenses.find((lens) => lens.command?.title.includes('temperatures'));
      assert.ok(temperatures, 'the list must have its own lens');
      assert.ok(
        temperatures.range.start.line < stopAt,
        'the lens belongs above the collection, not on the breakpoint'
      );
      assert.match(
        lines[temperatures.range.start.line] ?? '',
        /const temperatures\s*=/,
        'the lens must sit on the line that declares the collection'
      );
    });

    await test('the tooltip of a collection offers the Explore link', async () => {
      const column = (lines[stopAt] as string).indexOf('temperatures');
      assert.ok(column >= 0, 'the stopped line must mention the collection');

      console.log(`      diagnostics: hover position line=${stopAt} column=${column + 2}`);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        program,
        new vscode.Position(stopAt, column + 2)
      );
      const text = (hovers ?? [])
        .flatMap((hover) => hover.contents)
        .map((content) => (typeof content === 'string' ? content : content.value))
        .join('\n');

      assert.ok(
        text.includes('Explore collection'),
        `the hover must offer the viewer, saw: ${text.slice(0, 400)}`
      );
      assert.ok(text.includes('exploringCollections.explore'), 'the hover link must target the explore command');
    });

    await test('clicking the CodeLens opens the collection viewer', async () => {
      const before = webviewTabs().length;
      const lenses = exploreLenses(
        await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', program)
      );
      const lens = lenses.find((candidate) => candidate.command?.title.includes('temperatures'));
      assert.ok(lens?.command, 'the temperatures lens must exist');

      await vscode.commands.executeCommand(lens.command.command, ...(lens.command.arguments ?? []));
      await waitFor('the collection panel to open', () =>
        webviewTabs().length > before ? webviewTabs() : undefined
      );

      const tabs = webviewTabs();
      const opened = tabs[tabs.length - 1] as vscode.Tab;
      assert.ok(
        opened.label.includes('temperatures'),
        `the panel must be titled after the collection, got '${opened.label}'`
      );

      // Give the webview a moment to paint its first frame.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });

    await test('the context menu entry explores a variable the adapter reported', async () => {
      const before = webviewTabs().length;
      const variable = variables.find((candidate) => candidate.name === 'lookup');
      assert.ok(variable, 'the dictionary must be in scope');

      await vscode.commands.executeCommand('exploringCollections.explore', {
        sessionId: session.id,
        variable
      });
      await waitFor('the dictionary panel to open', () =>
        webviewTabs().length > before ? webviewTabs() : undefined
      );

      const tabs = webviewTabs();
      assert.ok(
        (tabs[tabs.length - 1] as vscode.Tab).label.includes('lookup'),
        'the dictionary must open in its own panel'
      );
    });

    await test('all 50000 elements of a big collection reach the viewer', async () => {
      const variable = variables.find((candidate) => candidate.name === 'employees');
      assert.ok(
        variable,
        `the big collection must be in scope, saw: ${variables.map((entry) => entry.name).join(', ')}`
      );

      const settings = vscode.workspace.getConfiguration('exploringCollections');
      // A window big enough for the whole collection, and a time budget that
      // only covers a few dozen walked rows: the pages must not depend on it.
      await settings.update('maxRows', 60000, vscode.ConfigurationTarget.Workspace);
      await settings.update('captureBudgetMs', 3000, vscode.ConfigurationTarget.Workspace);
      try {
        const before = webviewTabs().length;
        const started = Date.now();
        await vscode.commands.executeCommand('exploringCollections.explore', {
          sessionId: session.id,
          variable
        });
        const elapsed = Date.now() - started;

        await waitFor('the panel of the big collection', () =>
          webviewTabs().length > before ? webviewTabs() : undefined,
          60000
        );
        console.log(`      diagnostics: capturing 50000 elements took ${elapsed} ms`);

        await vscode.commands.executeCommand('exploringCollections.showDiagnostics');
        const report = vscode.window.activeTextEditor?.document.getText() ?? '';
        const row = report.split('\n').find((line) => line.startsWith('| employees')) ?? '';
        console.log(`      diagnostics: ${row.trim() || 'no row for employees'}`);
        const cells = row.split('|').map((cell) => cell.trim());
        // `| title | provider | strategy | rows | total | ms | requests |`
        const providerName = cells[2];
        const strategy = cells[3];
        const rows = Number(cells[4]);
        const total = Number(cells[5]);

        assert.equal(providerName, 'javascript', `the sample must be read as JavaScript, got ${providerName}`);
        assert.equal(rows, 50000, `the viewer must hold every element, it held ${rows}`);
        assert.equal(total, 50000, `the reported total must be the collection size, it was ${total}`);
        assert.equal(strategy, 'adapter-previews', `the preview fast path must be used, it was ${strategy}`);
        assert.ok(elapsed < 30000, `a 50000 element capture must stay fast, it took ${elapsed} ms`);
      } finally {
        await settings.update('maxRows', undefined, vscode.ConfigurationTarget.Workspace);
        await settings.update('captureBudgetMs', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });

    await test('the snapshot commands work on an opened panel', async () => {
      await assert.doesNotReject(async () => {
        await vscode.commands.executeCommand('exploringCollections.showChart');
        await vscode.commands.executeCommand('exploringCollections.copyRows');
        await vscode.commands.executeCommand('exploringCollections.pinSnapshot');
        await vscode.commands.executeCommand('exploringCollections.showDiagnostics');
      });
    });
  } finally {
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    if (vscode.debug.activeDebugSession) {
      await vscode.debug.stopDebugging();
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\nintegration: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    throw new Error(failed.map((result) => `${result.name}: ${result.error ?? 'failed'}`).join('\n'));
  }
}
