import { describe, it, expect } from 'vitest';
import { PROFILES, TOOL_NAMES, resolveToolPolicy } from '../src/policy.js';

const enabled = (...args: Parameters<typeof resolveToolPolicy>) => [...resolveToolPolicy(...args).enabled].sort();

describe('resolveToolPolicy', () => {
  it('exposes every tool when nothing is configured (the behaviour before 0.6.0)', () => {
    expect(enabled(undefined, undefined, 'site')).toEqual([...TOOL_NAMES].sort());
  });

  it('keeps everything that runs as the Drush superuser out of the restricted profiles', () => {
    const superuser = ['drupal_drush', 'drupal_php_eval', 'drupal_sql_query', 'drupal_config_get', 'drupal_config_set',
      'drupal_watchdog', 'drupal_user_create', 'drupal_user_block', 'drupal_entity_delete', 'drupal_cache_rebuild', 'drupal_file_upload'];
    for (const profile of ['read-only', 'content'] as const) {
      for (const tool of superuser) {
        expect(PROFILES[profile]).not.toContain(tool);
      }
    }
  });

  it('read-only has no tool that writes', () => {
    expect(enabled({ profile: 'read-only' }, undefined, 'site')).toEqual(
      ['drupal_entity_list', 'drupal_entity_read', 'drupal_field_info', 'drupal_introspect', 'drupal_status'],
    );
  });

  it('content adds the bridge writes and file attach, not standalone upload', () => {
    const tools = enabled({ profile: 'content' }, undefined, 'site');
    expect(tools).toContain('drupal_entity_create');
    expect(tools).toContain('drupal_entity_update');
    expect(tools).toContain('drupal_file_attach');
    expect(tools).not.toContain('drupal_file_upload');
  });

  it('adds with allow and removes with deny', () => {
    const tools = enabled({ profile: 'read-only', allow: ['drupal_watchdog'], deny: ['drupal_status'] }, undefined, 'site');
    expect(tools).toContain('drupal_watchdog');
    expect(tools).not.toContain('drupal_status');
  });

  it('can strip the power tools from full', () => {
    const tools = enabled({ deny: ['drupal_drush', 'drupal_php_eval', 'drupal_sql_query'] }, undefined, 'site');
    expect(tools).toHaveLength(TOOL_NAMES.length - 3);
    expect(tools).not.toContain('drupal_php_eval');
  });

  it('falls back to defaults.tools, and a site block replaces it whole', () => {
    expect(resolveToolPolicy(undefined, { profile: 'read-only' }, 'site').profile).toBe('read-only');
    const site = resolveToolPolicy({ profile: 'content' }, { profile: 'read-only', allow: ['drupal_php_eval'] }, 'site');
    expect(site.profile).toBe('content');
    expect(site.enabled.has('drupal_php_eval')).toBe(false);
  });

  it('refuses an unknown profile or tool name, naming where', () => {
    expect(() => resolveToolPolicy({ profile: 'readonly' }, undefined, "site 'prod'")).toThrow(/site 'prod': unknown tools profile "readonly"/);
    expect(() => resolveToolPolicy({ deny: ['drupal_phpeval'] }, undefined, 'site')).toThrow(/unknown tool "drupal_phpeval"/);
    expect(() => resolveToolPolicy({ allow: 'drupal_status' as unknown as string[] }, undefined, 'site')).toThrow(/must be a list/);
  });
});
