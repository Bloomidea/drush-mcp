import { execFile, spawn } from 'child_process';
import { quote } from 'shell-quote';
import { BaseTransport, type TransportConfig, type CommandParts, type BuildOptions } from './base.js';
import type { TransportResult } from '../types.js';

export interface DockerTransportConfig extends TransportConfig {
  host: string;
  user: string;
  container?: string;
  containerFilter?: string;
  drush?: string;
}

export class DockerTransport extends BaseTransport {
  private host:             string;
  private user:             string;
  private container?:       string;
  private containerFilter?: string;
  private drush:            string;

  constructor(config: DockerTransportConfig) {
    super(config);
    this.host            = config.host;
    this.user            = config.user;
    this.container       = config.container;
    this.containerFilter = config.containerFilter;
    this.drush           = config.drush ?? 'vendor/bin/drush';
  }

  private resolveContainer(): Promise<string> {
    if (this.container) {
      return Promise.resolve(this.container);
    }
    if (!this.containerFilter) {
      return Promise.reject(new Error('Docker transport requires either container or containerFilter.'));
    }
    return new Promise((resolve, reject) => {
      const filterArg = quote([this.containerFilter!]);
      execFile('ssh', [
        `${this.user}@${this.host}`,
        `docker ps --filter ${filterArg} --format '{{.Names}}' | head -1`,
      ], { timeout: 10000 }, (_error, stdout) => {
        const name = stdout.toString().trim();
        if (!name) {
          reject(new Error(`No container found matching filter: ${this.containerFilter}`));
          return;
        }
        resolve(name);
      });
    });
  }

  private buildPartsFor(container: string, drushCommand: string, args: string[], options?: BuildOptions): CommandParts {
    const escapedArgs = args.map(a => quote([a]));
    const drushParts  = [this.drush, drushCommand, ...escapedArgs].join(' ');
    // -i keeps stdin attached inside the container.
    const dockerExec  = options?.stdin
      ? `docker exec -i ${quote([container])} ${drushParts}`
      : `docker exec ${quote([container])} ${drushParts}`;
    // -T disables pseudo-TTY on the SSH hop so stdin streams cleanly.
    const sshArgs     = options?.stdin
      ? ['-T', `${this.user}@${this.host}`, dockerExec]
      : [`${this.user}@${this.host}`, dockerExec];
    return { file: 'ssh', args: sshArgs };
  }

  buildCommandParts(drushCommand: string, args: string[], options?: BuildOptions): CommandParts {
    return this.buildPartsFor(this.container!, drushCommand, args, options);
  }

  override async execute(drushCommand: string, args: string[]): Promise<TransportResult> {
    if (!this.container && this.containerFilter) {
      const resolved = await this.resolveContainer();
      const fullArgs = this.config.uri ? [...args, `--uri=${this.config.uri}`] : args;
      const parts    = this.buildPartsFor(resolved, drushCommand, fullArgs);

      return new Promise((resolve) => {
        execFile(parts.file, parts.args, { timeout: this.config.timeout * 1000 }, (error, stdout, stderr) => {
          resolve({
            stdout:   stdout.toString().trim(),
            stderr:   stderr.toString().trim(),
            exitCode: typeof error?.code === 'number' ? error.code : (error ? 1 : 0),
          });
        });
      });
    }

    return super.execute(drushCommand, args);
  }

  override async executeWithStdin(drushCommand: string, args: string[], stdin: Buffer): Promise<TransportResult> {
    if (!this.container && this.containerFilter) {
      const resolved = await this.resolveContainer();
      const fullArgs = this.config.uri ? [...args, `--uri=${this.config.uri}`] : args;
      const parts    = this.buildPartsFor(resolved, drushCommand, fullArgs, { stdin: true });

      return new Promise((resolve) => {
        const child = spawn(parts.file, parts.args, {
          timeout: this.config.timeout * 1000,
          stdio:   ['pipe', 'pipe', 'pipe'],
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
        child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
        child.stdin.on('error', () => { /* EPIPE on fast-fail */ });
        child.on('close', (code, signal) => {
          resolve({
            stdout:   Buffer.concat(stdoutChunks).toString().trim(),
            stderr:   Buffer.concat(stderrChunks).toString().trim(),
            exitCode: signal ? 1 : (code ?? 1),
          });
        });
        child.on('error', (err) => resolve({ stdout: '', stderr: err.message, exitCode: 1 }));
        child.stdin.end(stdin);
      });
    }

    return super.executeWithStdin(drushCommand, args, stdin);
  }
}
