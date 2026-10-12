import { createHash } from 'crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';

/**
 * One JSON line per tool call, appended to a local file.
 *
 * The log records what an agent asked a site to do and how it ended, so a
 * person can answer "what did the agent run on production last Tuesday"
 * without trusting the agent's own account. It is append-only from this
 * process (O_APPEND, never truncated or rewritten) and private to the user
 * running the server (0600 in a 0700 directory), because arguments include
 * PHP code, SQL and content.
 */

export const DEFAULT_AUDIT_LOG = '~/.drush-mcp/audit.jsonl';

export type AuditOutcome = 'ok' | 'error' | 'refused';

export interface AuditEntry {
  time:        string;
  site:        string | null;
  tool:        string;
  args:        unknown;
  outcome:     AuditOutcome;
  error?:      string;
  exit_code:   number | null;
  duration_ms: number;
}

// Long values are kept recognisable (head, length, hash) without filling the
// log with page bodies or file contents.
const MAX_STRING = 500;
const HEAD       = 200;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * The arguments as they go into the log: secrets replaced, file bytes reduced
 * to a hash, long strings cut to a head plus hash, at any depth.
 */
export function summarizeArgs(value: unknown, key = ''): unknown {
  if (/^(pass|password)$/i.test(key)) {
    return '[redacted]';
  }
  if (key === 'content_base64' && typeof value === 'string') {
    return { sha256: sha256(value), length: value.length };
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? { head: value.slice(0, HEAD), length: value.length, sha256: sha256(value) }
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeArgs(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarizeArgs(v, k)]));
  }
  return value;
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export class AuditLog {
  private constructor(private fd: number, readonly path: string) {}

  /**
   * Opens the log for appending, creating its directory. `false` turns it
   * off. Fails loudly, at startup, when the file cannot be opened: a server
   * that was asked to keep a log does not run without one.
   */
  static open(setting: string | false | undefined): AuditLog | null {
    if (setting === false) {
      return null;
    }
    if (setting !== undefined && typeof setting !== 'string') {
      throw new Error('defaults.audit_log must be a file path or false.');
    }
    const path = expandHome(setting ?? DEFAULT_AUDIT_LOG);
    if (!isAbsolute(path)) {
      throw new Error(`defaults.audit_log must be an absolute path or start with ~/, got ${JSON.stringify(setting)}.`);
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return new AuditLog(openSync(path, 'a', 0o600), path);
  }

  record(entry: AuditEntry): void {
    try {
      writeSync(this.fd, JSON.stringify(entry) + '\n');
    }
    catch (err) {
      // The call has already run; refusing its result now would not undo it.
      process.stderr.write(`drush-mcp: could not write the audit log ${this.path}: ${(err as Error).message}\n`);
    }
  }

  close(): void {
    closeSync(this.fd);
  }
}
