import { describe, it, expect } from 'vitest';
import {
  buildEntityCreateArgs,
  buildEntityReadArgs,
  buildEntityUpdateArgs,
  buildEntityListArgs,
  buildEntityDeleteArgs,
} from '../../src/tools/entity.js';

describe('entity tool argument builders', () => {
  it('buildEntityCreateArgs produces correct drush args', () => {
    const args = buildEntityCreateArgs({
      entity_type: 'node', bundle: 'article',
      fields: { title: 'Test' },
    });
    expect(args.command).toBe('mcp:entity-create');
    expect(args.args).toContain('--type=node');
    expect(args.args).toContain('--bundle=article');
    expect(args.args.some((a: string) => a.startsWith('--fields='))).toBe(true);
  });

  it('buildEntityReadArgs produces correct drush args', () => {
    const args = buildEntityReadArgs({ entity_type: 'node', id: 123 });
    expect(args.command).toBe('mcp:entity-read');
    expect(args.args).toContain('--type=node');
    expect(args.args).toContain('--id=123');
  });

  it('buildEntityUpdateArgs produces correct drush args', () => {
    const args = buildEntityUpdateArgs({ entity_type: 'node', id: 123, fields: { title: 'Updated' } });
    expect(args.command).toBe('mcp:entity-update');
    expect(args.args).toContain('--id=123');
  });

  it('buildEntityListArgs includes filters, limit, offset, sort', () => {
    const args = buildEntityListArgs({
      entity_type: 'node', bundle: 'article',
      filters: { status: 1 }, limit: 10, offset: 20, sort: 'created:DESC',
    });
    expect(args.command).toBe('mcp:entity-list');
    expect(args.args).toContain('--limit=10');
    expect(args.args).toContain('--offset=20');
    expect(args.args).toContain('--sort=created:DESC');
  });

  it('buildEntityCreateArgs includes --user when provided', () => {
    const args = buildEntityCreateArgs({
      entity_type: 'node', bundle: 'article',
      fields: { title: 'Test' }, user: 4,
    });
    expect(args.args).toContain('--user=4');
  });

  it('buildEntityDeleteArgs uses built-in entity:delete', () => {
    const args = buildEntityDeleteArgs({ entity_type: 'node', id: 123 });
    expect(args.command).toBe('entity:delete');
    expect(args.args).toContain('node');
    expect(args.args).toContain('123');
    expect(args.args).toContain('-y');
  });
});
