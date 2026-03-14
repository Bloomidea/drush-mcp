import { describe, it, expect } from 'vitest';
import {
  buildCacheRebuildArgs, buildWatchdogArgs, buildStatusArgs,
  buildConfigGetArgs, buildConfigSetArgs, buildFieldInfoArgs,
} from '../../src/tools/system.js';

describe('system tool argument builders', () => {
  it('cache:rebuild has no json format', () => {
    expect(buildCacheRebuildArgs().jsonFormat).toBe(false);
  });

  it('watchdog:show supports count and severity', () => {
    const args = buildWatchdogArgs({ count: 20, severity: 'error' });
    expect(args.args).toContain('--count=20');
    expect(args.args).toContain('--severity=error');
    expect(args.jsonFormat).toBe(true);
  });

  it('config:get takes config name and key', () => {
    const args = buildConfigGetArgs({ name: 'system.site', key: 'name' });
    expect(args.args).toContain('system.site');
    expect(args.args).toContain('name');
  });

  it('config:set includes -y', () => {
    const args = buildConfigSetArgs({ name: 'system.site', key: 'name', value: 'My Site' });
    expect(args.args).toContain('-y');
  });

  it('field:info takes entity type', () => {
    const args = buildFieldInfoArgs({ entity_type: 'node' });
    expect(args.args).toContain('--entity-type=node');
    expect(args.jsonFormat).toBe(true);
  });
});
