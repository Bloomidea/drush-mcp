import { quote } from 'shell-quote';
import { BaseTransport, type TransportConfig, type CommandParts } from './base.js';

export interface SshTransportConfig extends TransportConfig {
  host: string;
  user: string;
  drush?: string;
  root: string;
}

export class SshTransport extends BaseTransport {
  private host: string;
  private user: string;
  private drush: string;
  private root: string;

  constructor(config: SshTransportConfig) {
    super(config);
    this.host   = config.host;
    this.user   = config.user;
    this.drush  = config.drush ?? 'vendor/bin/drush';
    this.root   = config.root;
  }

  buildCommandParts(drushCommand: string, args: string[]): CommandParts {
    const escapedArgs = args.map(a => quote([a]));
    const drushParts  = [this.drush, drushCommand, ...escapedArgs].join(' ');
    const remoteCmd   = `cd ${quote([this.root])} && ${drushParts}`;
    return {
      file: 'ssh',
      args: [`${this.user}@${this.host}`, remoteCmd],
    };
  }
}
