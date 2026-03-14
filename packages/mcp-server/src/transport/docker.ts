import { quote } from 'shell-quote';
import { BaseTransport, type TransportConfig, type CommandParts } from './base.js';

export interface DockerTransportConfig extends TransportConfig {
  host: string;
  user: string;
  container: string;
  drush?: string;
}

export class DockerTransport extends BaseTransport {
  private host:      string;
  private user:      string;
  private container: string;
  private drush:     string;

  constructor(config: DockerTransportConfig) {
    super(config);
    this.host      = config.host;
    this.user      = config.user;
    this.container = config.container;
    this.drush     = config.drush ?? 'vendor/bin/drush';
  }

  buildCommandParts(drushCommand: string, args: string[]): CommandParts {
    const escapedArgs = args.map(a => quote([a]));
    const drushParts  = [this.drush, drushCommand, ...escapedArgs].join(' ');
    return {
      file: 'ssh',
      args: [`${this.user}@${this.host}`, `docker exec ${quote([this.container])} ${drushParts}`],
    };
  }
}
