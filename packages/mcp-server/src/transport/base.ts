import { execFile } from 'child_process';
import type { TransportResult } from '../types.js';

export interface TransportConfig {
  timeout: number;
  uri?: string;
}

export interface CommandParts {
  file: string;
  args: string[];
}

export abstract class BaseTransport {
  constructor(protected config: TransportConfig) {}

  abstract buildCommandParts(drushCommand: string, args: string[]): CommandParts;

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

  async test(): Promise<boolean> {
    try {
      const result = await this.execute('core:status', ['--format=json']);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}
