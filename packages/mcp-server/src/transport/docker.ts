import { execFile } from 'child_process';
import { quote } from 'shell-quote';
import { BaseTransport, type TransportConfig, type CommandParts } from './base.js';
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
      ], { timeout: 10000 }, (error, stdout) => {
        const name = stdout.toString().trim();
        if (!name) {
          reject(new Error(`No container found matching filter: ${this.containerFilter}`));
          return;
        }
        resolve(name);
      });
    });
  }

  buildCommandParts(drushCommand: string, args: string[]): CommandParts {
    const escapedArgs = args.map(a => quote([a]));
    const drushParts  = [this.drush, drushCommand, ...escapedArgs].join(' ');
    return {
      file: 'ssh',
      args: [`${this.user}@${this.host}`, `docker exec ${quote([this.container!])} ${drushParts}`],
    };
  }

  override async execute(drushCommand: string, args: string[]): Promise<TransportResult> {
    // Resolve container dynamically if using filter
    if (!this.container && this.containerFilter) {
      const resolved = await this.resolveContainer();
      // Build command with resolved container (don't cache - container may change on redeploy)
      const fullArgs    = this.config.uri ? [...args, `--uri=${this.config.uri}`] : args;
      const escapedArgs = fullArgs.map(a => quote([a]));
      const drushParts  = [this.drush, drushCommand, ...escapedArgs].join(' ');

      return new Promise((resolve) => {
        execFile('ssh', [
          `${this.user}@${this.host}`,
          `docker exec ${quote([resolved])} ${drushParts}`,
        ], { timeout: this.config.timeout * 1000 }, (error, stdout, stderr) => {
          resolve({
            stdout:   stdout.toString().trim(),
            stderr:   stderr.toString().trim(),
            exitCode: typeof error?.code === 'number' ? error.code : (error ? 1 : 0),
          });
        });
      });
    }

    // Fall back to parent execute() for static container
    return super.execute(drushCommand, args);
  }
}
