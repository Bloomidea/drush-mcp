import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog, summarizeArgs } from '../src/audit.js';

describe('summarizeArgs', () => {
  it('redacts passwords at any depth', () => {
    expect(summarizeArgs({ name: 'bob', password: 's3cret' })).toEqual({ name: 'bob', password: '[redacted]' });
    expect(summarizeArgs({ fields: { pass: 's3cret', name: 'bob' } })).toEqual({ fields: { pass: '[redacted]', name: 'bob' } });
  });

  it('reduces file bytes to a hash and a length', () => {
    const out = summarizeArgs({ content_base64: 'aGVsbG8=' }) as { content_base64: { sha256: string; length: number } };
    expect(out.content_base64.length).toBe(8);
    expect(out.content_base64.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(out)).not.toContain('aGVsbG8=');
  });

  it('cuts long strings to a head, a length and a hash, and keeps short ones', () => {
    const code = 'x'.repeat(2000);
    const out  = summarizeArgs({ code, short: 'echo 1;' }) as { code: { head: string; length: number }; short: string };
    expect(out.code.head).toHaveLength(200);
    expect(out.code.length).toBe(2000);
    expect(out.short).toBe('echo 1;');
  });

  it('walks arrays', () => {
    expect(summarizeArgs({ arguments: ['a', { password: 'x' }] })).toEqual({ arguments: ['a', { password: '[redacted]' }] });
  });
});

describe('AuditLog', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'drush-mcp-audit-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is off with false', () => {
    expect(AuditLog.open(false)).toBeNull();
  });

  it('appends one JSON line per entry to a private file, creating its directory', () => {
    const path = join(dir, 'nested', 'audit.jsonl');
    const log  = AuditLog.open(path)!;
    const entry = { time: 't', site: 's', tool: 'drupal_status', args: {}, outcome: 'ok' as const, exit_code: 0, duration_ms: 1 };
    log.record(entry);
    log.record({ ...entry, tool: 'drupal_php_eval' });
    log.close();

    const lines = readFileSync(path, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((l) => l.tool)).toEqual(['drupal_status', 'drupal_php_eval']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('appends to an existing log rather than replacing it', () => {
    const path = join(dir, 'twice.jsonl');
    for (const tool of ['one', 'two']) {
      const log = AuditLog.open(path)!;
      log.record({ time: 't', site: null, tool, args: {}, outcome: 'ok', exit_code: 0, duration_ms: 0 });
      log.close();
    }
    expect(readFileSync(path, 'utf-8').trim().split('\n')).toHaveLength(2);
  });

  it('refuses a relative path or a value that is not a path', () => {
    expect(() => AuditLog.open('audit.jsonl')).toThrow(/absolute path/);
    expect(() => AuditLog.open(true as unknown as string)).toThrow(/file path or false/);
  });
});
