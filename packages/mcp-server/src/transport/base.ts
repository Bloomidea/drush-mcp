import { execFile, spawn } from 'child_process';
import type { TransportResult } from '../types.js';

export interface TransportConfig {
  timeout: number;
  uri?: string;
}

export interface CommandParts {
  file: string;
  args: string[];
}

export interface BuildOptions {
  stdin?: boolean;
}

/**
 * The shape of a Drush command name: `cr`, `cache:rebuild`, `mcp:entity-create`.
 *
 * The name is the one value every tool hands a transport outside the argument
 * list, and `drupal_drush` takes it straight from the agent. Before 0.5.1 the
 * ssh and docker transports spliced it unquoted into the remote command line,
 * so `status; id` ran `id` on the host, outside the container. Quoting closes
 * that; this check also keeps the name from being read as a Drush option
 * (`--root=...`), which quoting cannot.
 */
export const DRUSH_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

export function assertDrushCommandName(name: string): void {
  if (!DRUSH_COMMAND_NAME.test(name)) {
    throw new Error(`${JSON.stringify(name)} is not a valid Drush command name. Pass options and arguments separately, not in the command.`);
  }
}

export abstract class BaseTransport {
  constructor(protected config: TransportConfig) {}

  abstract buildCommandParts(drushCommand: string, args: string[], options?: BuildOptions): CommandParts;

  async execute(drushCommand: string, args: string[]): Promise<TransportResult> {
    const fullArgs = this.config.uri
      ? [...args, `--uri=${this.config.uri}`]
      : args;
    const parts = this.buildCommandParts(drushCommand, fullArgs);

    return new Promise((resolve) => {
      execFile(parts.file, parts.args, { timeout: this.config.timeout * 1000 }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout.toString().trim(),
          stderr: stderr.toString().trim(),
          exitCode: typeof error?.code === 'number' ? error.code : (error ? 1 : 0),
        });
      });
    });
  }

  async executeWithStdin(drushCommand: string, args: string[], stdin: Buffer): Promise<TransportResult> {
    const fullArgs = this.config.uri
      ? [...args, `--uri=${this.config.uri}`]
      : args;
    const parts = this.buildCommandParts(drushCommand, fullArgs, { stdin: true });

    return new Promise((resolve) => {
      const child = spawn(parts.file, parts.args, {
        timeout:  this.config.timeout * 1000,
        stdio:    ['pipe', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      // EPIPE on stdin is expected when the bridge fast-fails validation
      // before consuming all input — swallow rather than crashing.
      child.stdin.on('error', () => { /* ignore */ });

      child.on('close', (code, signal) => {
        resolve({
          stdout:   Buffer.concat(stdoutChunks).toString().trim(),
          stderr:   Buffer.concat(stderrChunks).toString().trim(),
          exitCode: signal ? 1 : (code ?? 1),
        });
      });

      child.on('error', (err) => {
        resolve({ stdout: '', stderr: err.message, exitCode: 1 });
      });

      child.stdin.end(stdin);
    });
  }

  async test(): Promise<boolean> {
    try {
      const result = await this.execute('core:status', ['--format=json']);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
