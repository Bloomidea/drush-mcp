export interface TransportResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SiteConfig {
  name: string;
  transport: 'local' | 'ssh' | 'docker';
  host?: string;
  user?: string;
  root?: string;
  container?: string;
  command?: string;
  drush?: string;
  uri?: string;
  timeout?: number;
}

export interface DrushMcpConfig {
  sites: Record<string, SiteConfig>;
  defaults?: {
    timeout?: number;
    drush?: string;
  };
}

export interface DrushArgs {
  command: string;
  args: string[];
  jsonFormat?: boolean;
}

export interface DrushError {
  error: string;
  message?: string;
  exit_code?: number;
  command?: string;
  site?: string;
  violations?: Array<{ field: string; message: string }>;
}
