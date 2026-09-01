import { describe, it, expect } from 'vitest';
import { DockerTransport } from '../../src/transport/docker.js';

describe('DockerTransport', () => {
  it('builds ssh + docker exec command parts', () => {
    const transport = new DockerTransport({
      host: '176.9.125.8',
      user: 'root',
      container: 'atrium-web',
      drush: '/app/vendor/bin/drush',
      timeout: 30,
    });
    const parts = transport.buildCommandParts('cache:rebuild', []);
    expect(parts.file).toBe('ssh');
    expect(parts.args[0]).toBe('root@176.9.125.8');
    expect(parts.args[1]).toContain("docker exec 'atrium-web'");
    expect(parts.args[1]).toContain('/app/vendor/bin/drush cache:rebuild');
  });

  it('passes arguments through docker exec', () => {
    const transport = new DockerTransport({
      host: '176.9.125.8',
      user: 'root',
      container: 'atrium-web',
      drush: '/app/vendor/bin/drush',
      timeout: 30,
    });
    const parts = transport.buildCommandParts('core:status', ['--format=json']);
    expect(parts.args[1]).toContain('/app/vendor/bin/drush core:status');
    expect(parts.args[1]).toContain('--format=json');
  });

  it('can be constructed with containerFilter instead of container', () => {
    const transport = new DockerTransport({
      host: 'x.com', user: 'root', containerFilter: 'label=app=drupal', timeout: 30,
    });
    expect(transport).toBeDefined();
  });

  it('inserts -T (ssh) and -i (docker exec) when building for stdin streaming', () => {
    const transport = new DockerTransport({
      host: '176.9.125.8',
      user: 'root',
      container: 'atrium-web',
      drush: '/app/vendor/bin/drush',
      timeout: 30,
    });
    const parts = transport.buildCommandParts('mcp:file-upload', ['--filename=a.txt'], { stdin: true });
    expect(parts.args[0]).toBe('-T');
    expect(parts.args[2]).toContain("docker exec -i 'atrium-web'");
  });
});
