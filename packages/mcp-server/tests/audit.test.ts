import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog, summarizeArgs, summarizeCall } from '../src/audit.js';

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

  it('redacts any credential-shaped name, not only password', () => {
    expect(summarizeArgs({ fields: { field_api_key: 'k', field_secret: 's', token: 't', title: 'kept' } }))
      .toEqual({ fields: { field_api_key: '[redacted]', field_secret: '[redacted]', token: '[redacted]', title: 'kept' } });
  });

  it('leaves names that merely contain the letters alone', () => {
    expect(summarizeArgs({ passage: 'p', key: 'name', tokenizer: 't' })).toEqual({ passage: 'p', key: 'name', tokenizer: 't' });
  });
});

describe('summarizeCall', () => {
  it('redacts the value of a config_set on a credential key', () => {
    expect(summarizeCall('drupal_config_set', { name: 'smtp.settings', key: 'smtp_password', value: 'hunter2' }))
      .toEqual({ name: 'smtp.settings', key: 'smtp_password', value: '[redacted]' });
    expect(summarizeCall('drupal_config_set', { name: 'system.site', key: 'name', value: 'Atrium' }))
      .toEqual({ name: 'system.site', key: 'name', value: 'Atrium' });
  });

  it('redacts the password of drush user:password', () => {
    expect(summarizeCall('drupal_drush', { command: 'user:password', arguments: ['admin', 'hunter2'] }))
      .toEqual({ command: 'user:password', arguments: ['admin', '[redacted]'] });
  });

  it('redacts credential options and config:set values passed through drupal_drush', () => {
    expect(summarizeCall('drupal_drush', { command: 'user:create', arguments: ['bob', '--password=hunter2', '--mail=b@x.pt'] }))
      .toEqual({ command: 'user:create', arguments: ['bob', '--password=[redacted]', '--mail=b@x.pt'] });
    expect(summarizeCall('drupal_drush', { command: 'sql:cli', arguments: ['--db-password=hunter2'] }))
      .toEqual({ command: 'sql:cli', arguments: ['--db-password=[redacted]'] });
    expect(summarizeCall('drupal_drush', { command: 'config:set', arguments: ['smtp.settings', 'smtp_password', 'hunter2', '-y'] }))
      .toEqual({ command: 'config:set', arguments: ['smtp.settings', 'smtp_password', '[redacted]', '-y'] });
  });

  it('redacts a credential option given as two arguments', () => {
    expect(summarizeCall('drupal_drush', { command: 'user:create', arguments: ['bob', '--password', 'hunter2', '--mail', 'b@x.pt'] }))
      .toEqual({ command: 'user:create', arguments: ['bob', '--password', '[redacted]', '--mail', 'b@x.pt'] });
  });

  it('redacts the password inside a URL, whatever the option is called', () => {
    expect(summarizeCall('drupal_drush', { command: 'sql:sync', arguments: ['--db-url=mysql://drupal:hunter2@db:3306/site'] }))
      .toEqual({ command: 'sql:sync', arguments: ['--db-url=mysql://drupal:[redacted]@db:3306/site'] });
    expect(summarizeArgs({ value: 'see https://example.com/path and ftp://u:p@h/x' }))
      .toEqual({ value: 'see https://example.com/path and ftp://u:[redacted]@h/x' });
  });

  it('finds secrets inside fields sent as a JSON string', () => {
    const out = summarizeCall('drupal_entity_create', { entity_type: 'user', fields: '{"name":"bob","pass":"hunter2"}' });
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(out).toEqual({ entity_type: 'user', fields: { name: 'bob', pass: '[redacted]' } });
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
