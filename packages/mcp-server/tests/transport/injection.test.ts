import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SshTransport } from '../../src/transport/ssh.js';
import { DockerTransport } from '../../src/transport/docker.js';
import { LocalTransport } from '../../src/transport/local.js';

/**
 * The remote half of the ssh and docker transports is a shell command line
 * that the server's login shell parses. These tests build that line and hand
 * it to a real bash, so they catch any value that still reaches the shell as
 * syntax rather than data.
 */

let sandbox: string;
let marker:  string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'drush-mcp-injection-'));
  marker  = join(sandbox, 'pwned');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// Each payload tries to create the marker file through a different piece of
// shell syntax.
const commandPayloads = (m: string): Array<[string, string]> => [
  ['semicolon',            `status; touch ${m}`],
  ['command substitution', `status$(touch ${m})`],
  ['backticks',            `status\`touch ${m}\``],
  ['pipe',                 `status | touch ${m}`],
  ['and-list',             `status && touch ${m}`],
  ['newline',              `status\ntouch ${m}`],
];

function ssh(overrides: Partial<ConstructorParameters<typeof SshTransport>[0]> = {}): SshTransport {
  return new SshTransport({ host: 'example.com', user: 'deploy', root: sandbox, timeout: 30, ...overrides });
}

function docker(overrides: Partial<ConstructorParameters<typeof DockerTransport>[0]> = {}): DockerTransport {
  return new DockerTransport({ host: 'example.com', user: 'root', container: 'web', timeout: 30, ...overrides });
}

describe('drush command name', () => {
  for (const [label, payload] of commandPayloads('/tmp/x')) {
    it(`ssh refuses a command carrying a ${label}`, () => {
      expect(() => ssh().buildCommandParts(payload, [])).toThrow(/not a valid Drush command name/);
    });

    it(`docker refuses a command carrying a ${label}`, () => {
      expect(() => docker().buildCommandParts(payload, [])).toThrow(/not a valid Drush command name/);
    });

    it(`local refuses a command carrying a ${label}`, () => {
      const local = new LocalTransport({ command: 'drush', timeout: 30 });
      expect(() => local.buildCommandParts(payload, [])).toThrow(/not a valid Drush command name/);
    });
  }

  it('refuses a command that would be read as an option', () => {
    expect(() => ssh().buildCommandParts('--root=/tmp', [])).toThrow(/not a valid Drush command name/);
    expect(() => ssh().buildCommandParts('', [])).toThrow(/not a valid Drush command name/);
  });

  it('accepts the command names drush and the bridge actually use', () => {
    for (const name of ['cr', 'cache:rebuild', 'php:eval', 'mcp:entity-create', 'tool:run', 'bloom:task:slug', 'pm:list', 'sql:query', 'watchdog:show', 'Foo_bar.baz']) {
      expect(() => ssh().buildCommandParts(name, [])).not.toThrow();
      expect(() => docker().buildCommandParts(name, [])).not.toThrow();
    }
  });

  it('rejects the command before the docker transport looks up a container', async () => {
    const transport = docker({ container: undefined, containerFilter: 'label=x' });
    await expect(transport.execute('status; id', [])).rejects.toThrow(/not a valid Drush command name/);
  });
});

describe('remote command line', () => {
  it('ssh quotes the command, the drush words and the root', () => {
    const parts = ssh({ root: '/var/www/html', drush: 'vendor/bin/drush' }).buildCommandParts('cache:rebuild', ['--format=json']);
    expect(parts.args[1]).toBe(`cd '/var/www/html' && 'vendor/bin/drush' 'cache:rebuild' '--format=json'`);
  });

  it('docker quotes the container, the drush words and the command', () => {
    const parts = docker({ drush: '/app/vendor/bin/drush' }).buildCommandParts('cache:rebuild', ['--format=json']);
    expect(parts.args[1]).toBe(`docker exec 'web' '/app/vendor/bin/drush' 'cache:rebuild' '--format=json'`);
  });

  it('keeps a multi-word drush setting working, one quoted word each', () => {
    const parts = ssh({ root: '/app', drush: 'php -d memory_limit=-1 vendor/bin/drush' }).buildCommandParts('status', []);
    expect(parts.args[1]).toBe(`cd '/app' && 'php' '-d' 'memory_limit=-1' 'vendor/bin/drush' 'status'`);
  });

  // `printf %s` stands in for drush, so whatever reaches it as data comes
  // back on stdout, and whatever reached bash as syntax would touch the marker.
  it('runs through a real bash without executing anything an argument carries', () => {
    const transport = new SshTransport({ host: 'h', user: 'u', root: sandbox, drush: 'printf %s', timeout: 30 });
    const args      = commandPayloads(marker).map(([, payload]) => payload);
    const parts     = transport.buildCommandParts('ok', args);
    const output    = execFileSync('bash', ['-c', parts.args[1]]).toString();
    expect(output).toBe(['ok', ...args].join(''));
    expect(existsSync(marker)).toBe(false);
  });

  it('runs a root carrying shell syntax as a plain directory name', () => {
    const transport = new SshTransport({ host: 'h', user: 'u', root: `${sandbox}/$(touch ${marker})`, drush: 'printf', timeout: 30 });
    const parts     = transport.buildCommandParts('ok', []);
    expect(() => execFileSync('bash', ['-c', parts.args[1]], { stdio: 'pipe' })).toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it('runs a drush setting carrying shell syntax as plain words', () => {
    const transport = new SshTransport({ host: 'h', user: 'u', root: sandbox, drush: `printf;touch ${marker}`, timeout: 30 });
    const parts     = transport.buildCommandParts('ok', []);
    expect(() => execFileSync('bash', ['-c', parts.args[1]], { stdio: 'pipe' })).toThrow();
    expect(existsSync(marker)).toBe(false);
  });
});
