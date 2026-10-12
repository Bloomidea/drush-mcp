import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { TOOL_NAMES } from '../src/policy.js';
import type { DrushMcpConfig, SiteConfig } from '../src/types.js';

/**
 * Drives the real server through an MCP client. The sites use the local
 * transport with a fake drush that prints the arguments it received, so the
 * tests see exactly what would reach Drush, and answers mcp:entity-read with
 * a bridge-style error so the audit log has one to record.
 */

let dir:      string;
let drush:    string;
let oldDrush: string;

function fakeDrush(path: string, bridgeInfo: string): void {
  writeFileSync(path, [
    '#!/bin/sh',
    bridgeInfo,
    'if [ "$1" = "mcp:entity-read" ]; then printf \'{"error":"access_denied","message":"no"}\'; exit 0; fi',
    'printf "%s|" "$@"',
    '',
  ].join('\n'));
  chmodSync(path, 0o755);
}

beforeAll(() => {
  dir      = mkdtempSync(join(tmpdir(), 'drush-mcp-server-'));
  drush    = join(dir, 'fake-drush');
  oldDrush = join(dir, 'old-drush');
  fakeDrush(drush, 'if [ "$1" = "mcp:bridge-info" ]; then printf \'{"capabilities":["access-checks"]}\'; exit 0; fi');
  // A 0.5 bridge: the command does not exist.
  fakeDrush(oldDrush, 'if [ "$1" = "mcp:bridge-info" ]; then echo \'Command "mcp:bridge-info" is not defined.\' >&2; exit 1; fi');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let logCount = 0;

function setup(sites: Record<string, Partial<SiteConfig>>, defaults: DrushMcpConfig['defaults'] = {}) {
  const log    = join(dir, `audit-${++logCount}.jsonl`);
  const config: DrushMcpConfig = {
    sites:    Object.fromEntries(Object.entries(sites).map(([name, site]) => [name, { name, transport: 'local', command: drush, timeout: 10, ...site } as SiteConfig])),
    defaults: { audit_log: log, ...defaults },
  };
  return { config, log };
}

async function connect(config: DrushMcpConfig): Promise<Client> {
  const server             = createServer(config, 'test');
  const [serverEnd, clientEnd] = InMemoryTransport.createLinkedPair();
  const client             = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverEnd), client.connect(clientEnd)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
  return { text: result.content[0].text, isError: result.isError === true };
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).sort();
const auditLines = (path: string) => readFileSync(path, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));

describe('tool profiles', () => {
  it('lists every tool by default', async () => {
    const client = await connect(setup({ s: {} }).config);
    expect(await toolNames(client)).toEqual([...TOOL_NAMES].sort());
  });

  it('lists only the profile\'s tools on a single read-only site', async () => {
    const client = await connect(setup({ s: { tools: { profile: 'read-only' } } }).config);
    expect(await toolNames(client)).toEqual(['drupal_entity_list', 'drupal_entity_read', 'drupal_field_info', 'drupal_introspect', 'drupal_status']);
  });

  it('refuses a tool on the site that switched it off while another site keeps it', async () => {
    const client = await connect(setup({ prod: { tools: { profile: 'read-only' } }, dev: {} }).config);
    expect(await toolNames(client)).toContain('drupal_php_eval');

    const refused = await call(client, 'drupal_php_eval', { code: 'echo 1;', site: 'prod' });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.text)).toMatchObject({ error: 'tool_disabled', site: 'prod' });

    const allowed = await call(client, 'drupal_php_eval', { code: 'echo 1;', site: 'dev' });
    expect(allowed).toEqual({ text: 'php:eval|echo 1;|', isError: false });
  });

  it('stops at startup on a typo in the policy', () => {
    expect(() => createServer(setup({ s: { tools: { profile: 'readonly' } } }).config, 'test')).toThrow(/unknown tools profile/);
    expect(() => createServer(setup({ s: { run_as: -1 } }).config, 'test')).toThrow(/run_as must be a Drupal user ID/);
  });
});

describe('acting account', () => {
  it('runs as run_as when the agent names nobody', async () => {
    const client = await connect(setup({ s: { run_as: 4 } }).config);
    expect((await call(client, 'drupal_entity_list', { entity_type: 'node' })).text).toBe('mcp:entity-list|--type=node|--user=4|');
  });

  it('sends --user=0 without run_as, so even a 0.5 bridge acts as anonymous and not as uid 1', async () => {
    const client = await connect(setup({ s: {} }).config);
    expect((await call(client, 'drupal_entity_list', { entity_type: 'node' })).text).toBe('mcp:entity-list|--type=node|--user=0|');
  });

  it('lets the agent name any account on a full site', async () => {
    const client = await connect(setup({ s: { run_as: 4 } }).config);
    expect((await call(client, 'drupal_entity_list', { entity_type: 'node', user: 1 })).text).toBe('mcp:entity-list|--type=node|--user=1|');
  });

  it('pins the account to run_as on a restricted site', async () => {
    const client = await connect(setup({ s: { run_as: 4, tools: { profile: 'content' } } }).config);
    expect((await call(client, 'drupal_entity_list', { entity_type: 'node', user: 4 })).isError).toBe(false);

    const refused = await call(client, 'drupal_entity_update', { entity_type: 'node', id: 1, fields: { title: 'x' }, user: 1 });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.text)).toMatchObject({ error: 'user_not_allowed' });
    expect(JSON.parse(refused.text).message).toMatch(/runs bridge commands as uid 4/);
  });

  it('pins the file owner and acting account too', async () => {
    const client = await connect(setup({ s: { run_as: 4, tools: { profile: 'content' } } }).config);
    const args   = { content_base64: Buffer.from('x').toString('base64'), filename: 'a.txt', entity_type: 'node', entity_id: 1, field_name: 'field_files' };

    const sent = (await call(client, 'drupal_file_attach', args)).text.split('|');
    expect(sent).toContain('--uid=0');
    expect(sent).toContain('--user=4');

    const refused = await call(client, 'drupal_file_attach', { ...args, uid: 1 });
    expect(JSON.parse(refused.text)).toMatchObject({ error: 'user_not_allowed' });
  });

  it('acts as anonymous, not as default_uid, when nobody is named', async () => {
    const client = await connect(setup({ s: { file_upload: { default_uid: 1 } } }).config);
    const sent   = (await call(client, 'drupal_file_upload', { content_base64: Buffer.from('x').toString('base64'), filename: 'a.txt' })).text.split('|');
    expect(sent).toContain('--uid=1');
    expect(sent).toContain('--user=0');
  });

  it('lets the file land only where the field puts it on a restricted site', async () => {
    const client = await connect(setup({ s: { run_as: 4, tools: { profile: 'content' } } }).config);
    const args   = { content_base64: Buffer.from('x').toString('base64'), filename: 'a.png', entity_type: 'node', entity_id: 1, field_name: 'field_image' };
    for (const extra of [{ destination: 'styles/thumbnail/public' }, { scheme: 'public' }]) {
      const refused = await call(client, 'drupal_file_attach', { ...args, ...extra });
      expect(JSON.parse(refused.text)).toMatchObject({ error: 'param_not_allowed' });
    }
  });

  it('refuses a restricted profile on a bridge without access checks, and leaves full alone', async () => {
    const restricted = await connect(setup({ s: { command: oldDrush, tools: { profile: 'read-only' } } }).config);
    const refused    = await call(restricted, 'drupal_entity_read', { entity_type: 'node', id: 1 });
    expect(JSON.parse(refused.text)).toMatchObject({ error: 'bridge_too_old' });

    const full = await connect(setup({ s: { command: oldDrush } }).config);
    expect((await call(full, 'drupal_entity_list', { entity_type: 'node' })).isError).toBe(false);
  });

  it('sends no --user to the bridge when the agent names the owner itself', async () => {
    const client = await connect(setup({ s: {} }).config);
    const sent   = (await call(client, 'drupal_file_upload', { content_base64: Buffer.from('x').toString('base64'), filename: 'a.txt', uid: 4 })).text.split('|');
    expect(sent).toContain('--uid=4');
    expect(sent.some((arg) => arg.startsWith('--user='))).toBe(false);
  });
});

describe('drupal_status', () => {
  it('asks Drush for every status field but the database credentials', async () => {
    const client = await connect(setup({ s: {} }).config);
    const sent   = (await call(client, 'drupal_status', {})).text;
    expect(sent).toMatch(/^core:status\|--fields=drupal-version,/);
    expect(sent).not.toContain('db-password');
    expect(sent).not.toContain('db-username');
  });
});

describe('audit log', () => {
  it('records one line per call, however it ends', async () => {
    const { config, log } = setup({ prod: { tools: { profile: 'read-only' } }, dev: {} });
    const client = await connect(config);

    await call(client, 'drupal_status', { site: 'dev' });
    await call(client, 'drupal_php_eval', { code: 'echo 1;', site: 'prod' });
    await call(client, 'drupal_entity_read', { entity_type: 'node', id: 2, site: 'dev' });
    await call(client, 'drupal_user_create', { name: 'bob', password: 's3cret', site: 'dev' });
    await call(client, 'drupal_file_upload', { content_base64: Buffer.from('secret bytes').toString('base64'), filename: 'a.exe', site: 'dev' });

    const lines = auditLines(log);
    expect(lines.map((l) => [l.tool, l.site, l.outcome, l.error ?? null])).toEqual([
      ['drupal_status',      'dev',  'ok',      null],
      ['drupal_php_eval',    'prod', 'refused', 'tool_disabled'],
      ['drupal_entity_read', 'dev',  'error',   'access_denied'],
      ['drupal_user_create', 'dev',  'ok',      null],
      ['drupal_file_upload', 'dev',  'error',   'EXTENSION_FORBIDDEN'],
    ]);
    expect(lines[0]).toMatchObject({ exit_code: 0 });
    expect(lines[0]).not.toHaveProperty('as');
    expect(lines[2]).toMatchObject({ as: 0 });
    expect(lines[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof lines[0].duration_ms).toBe('number');
    expect(lines[3].args).toEqual({ name: 'bob', password: '[redacted]' });
    expect(readFileSync(log, 'utf-8')).not.toContain(Buffer.from('secret bytes').toString('base64'));
  });

  it('writes nothing when switched off', async () => {
    const { config, log } = setup({ s: {} }, { audit_log: false });
    const client = await connect(config);
    await call(client, 'drupal_status', {});
    expect(existsSync(log)).toBe(false);
  });
});
