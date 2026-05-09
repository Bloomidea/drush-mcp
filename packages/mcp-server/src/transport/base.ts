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
