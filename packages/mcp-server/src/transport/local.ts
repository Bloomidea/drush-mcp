import { BaseTransport, type TransportConfig, type CommandParts } from './base.js';

export interface LocalTransportConfig extends TransportConfig {
  command: string;
}

export class LocalTransport extends BaseTransport {
  private commandParts: string[];

  constructor(config: LocalTransportConfig) {
    super(config);
    // Split "ddev drush" into ["ddev", "drush"]
    this.commandParts = config.command.split(/\s+/);
  }

  buildCommandParts(drushCommand: string, args: string[]): CommandParts {
    const [file, ...prefix] = this.commandParts;
    return {
      file,
      args: [...prefix, drushCommand, ...args],
    };
  }
}
