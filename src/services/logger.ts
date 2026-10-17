import * as vscode from 'vscode';
import type { Logger } from '../util/logging';
import { formatError } from '../util/logging';

/** Output channel backed logger with a bounded diagnostics ring buffer. */
export class ExtensionLogger implements Logger, vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;
  private readonly diagnostics: string[] = [];

  constructor() {
    this.channel = vscode.window.createOutputChannel('Exploring Collections', { log: true });
  }

  trace(message: string): void {
    this.channel.trace(message);
  }

  debug(message: string): void {
    this.channel.debug(message);
  }

  info(message: string): void {
    this.channel.info(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
    this.record(`WARN  ${message}`);
  }

  error(message: string, error?: unknown): void {
    const suffix = error === undefined ? '' : `: ${formatError(error)}`;
    this.channel.error(`${message}${suffix}`);
    this.record(`ERROR ${message}${suffix}`);
  }

  /** Records a line in the diagnostics report. */
  record(line: string): void {
    this.diagnostics.push(`${new Date().toISOString()} ${line}`);
    if (this.diagnostics.length > 500) {
      this.diagnostics.splice(0, this.diagnostics.length - 500);
    }
  }

  /** Diagnostics lines collected so far, oldest first. */
  get diagnosticsLines(): readonly string[] {
    return this.diagnostics;
  }

  show(preserveFocus = false): void {
    this.channel.show(preserveFocus);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
