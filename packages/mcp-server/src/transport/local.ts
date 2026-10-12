import { BaseTransport, assertDrushCommandName, type TransportConfig, type CommandParts, type BuildOptions } from './base.js';

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

  buildCommandParts(drushCommand: string, args: string[], _options?: BuildOptions): CommandParts {
    // No shell here (execFile), but `ddev drush` and friends hand the words to
    // one inside the container, and a name like `--root=...` is an option.
    assertDrushCommandName(drushCommand);
    const [file, ...prefix] = this.commandParts;
    return {
      file,
      args: [...prefix, drushCommand, ...args],
    };
  }
}
