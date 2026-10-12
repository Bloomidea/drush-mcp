import { shellQuote } from './shell.js';
import { BaseTransport, assertDrushCommandName, type TransportConfig, type CommandParts, type BuildOptions } from './base.js';

export interface SshTransportConfig extends TransportConfig {
  host: string;
  user: string;
  drush?: string;
  root: string;
}

export class SshTransport extends BaseTransport {
  private host: string;
  private user: string;
  private drush: string[];
  private root: string;

  constructor(config: SshTransportConfig) {
    super(config);
    this.host   = config.host;
    this.user   = config.user;
    // Words, not a shell snippet: `php -d memory_limit=-1 vendor/bin/drush`
    // still works, `$HOME` or `~` no longer expand.
    this.drush  = (config.drush ?? 'vendor/bin/drush').trim().split(/\s+/);
    this.root   = config.root;
  }

  buildCommandParts(drushCommand: string, args: string[], options?: BuildOptions): CommandParts {
    assertDrushCommandName(drushCommand);
    const drushParts  = [...this.drush, drushCommand, ...args].map(shellQuote).join(' ');
    const remoteCmd   = `cd ${shellQuote(this.root)} && ${drushParts}`;
    // -T disables pseudo-TTY allocation so stdin streams cleanly.
    const sshArgs     = options?.stdin
      ? ['-T', `${this.user}@${this.host}`, remoteCmd]
      : [`${this.user}@${this.host}`, remoteCmd];
    return {
      file: 'ssh',
      args: sshArgs,
    };
  }
}
