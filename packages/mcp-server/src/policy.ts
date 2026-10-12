/**
 * Which tools a site exposes, and as whom its bridge commands run.
 *
 * A profile is a starting set; `allow` adds to it and `deny` removes from it.
 * The two restricted profiles hold only tools that go through Drupal's own
 * access checks (the `mcp:*` bridge commands), plus two that read structure
 * and status. Everything that runs as the Drush superuser (config, logs, raw
 * Drush, PHP, SQL, users, deletes, cache) is `full` only, and an operator who
 * wants one of them in a restricted profile names it in `allow`.
 */

export const TOOL_NAMES = [
  'drupal_entity_create',
  'drupal_entity_read',
  'drupal_entity_update',
  'drupal_entity_list',
  'drupal_entity_delete',
  'drupal_introspect',
  'drupal_cache_rebuild',
  'drupal_watchdog',
  'drupal_status',
  'drupal_config_get',
  'drupal_config_set',
  'drupal_field_info',
  'drupal_user_create',
  'drupal_user_block',
  'drupal_file_upload',
  'drupal_file_attach',
  'drupal_drush',
  'drupal_php_eval',
  'drupal_sql_query',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const READ_ONLY: ToolName[] = [
  'drupal_entity_read',
  'drupal_entity_list',
  'drupal_introspect',
  'drupal_field_info',
  'drupal_status',
];

export const PROFILES = {
  'read-only': READ_ONLY,
  // drupal_file_attach and not drupal_file_upload: attaching checks update
  // access on the target entity, a standalone upload has nothing to check.
  'content':   [...READ_ONLY, 'drupal_entity_create', 'drupal_entity_update', 'drupal_file_attach'],
  'full':      [...TOOL_NAMES],
} satisfies Record<string, ToolName[]>;

export type ProfileName = keyof typeof PROFILES;

export interface ToolsConfig {
  profile?: string;
  allow?: string[];
  deny?: string[];
}

export interface ToolPolicy {
  profile: ProfileName;
  enabled: ReadonlySet<ToolName>;
}

function toolList(value: unknown, key: string, where: string): ToolName[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${where}: tools.${key} must be a list of tool names.`);
  }
  for (const name of value) {
    if (!(TOOL_NAMES as readonly unknown[]).includes(name)) {
      throw new Error(`${where}: tools.${key} names an unknown tool ${JSON.stringify(name)}. Known tools: ${TOOL_NAMES.join(', ')}.`);
    }
  }
  return value as ToolName[];
}

/**
 * Resolves the tool policy for one site from its own `tools` block and the
 * config's `defaults.tools`. The site's block wins as a whole: a site that
 * sets `tools` does not inherit the defaults' allow or deny lists, so reading
 * one block tells you what the site exposes.
 *
 * Throws on an unknown profile or tool name, so a typo stops the server at
 * startup instead of leaving a tool switched on.
 */
export function resolveToolPolicy(site: ToolsConfig | undefined, defaults: ToolsConfig | undefined, where: string): ToolPolicy {
  const block   = site ?? defaults ?? {};
  const profile = block.profile ?? 'full';
  if (!Object.hasOwn(PROFILES, profile)) {
    throw new Error(`${where}: unknown tools profile ${JSON.stringify(profile)}. Use one of: ${Object.keys(PROFILES).join(', ')}.`);
  }
  const enabled = new Set<ToolName>(PROFILES[profile as ProfileName]);
  for (const name of toolList(block.allow, 'allow', where)) enabled.add(name);
  for (const name of toolList(block.deny, 'deny', where)) enabled.delete(name);
  return { profile: profile as ProfileName, enabled };
}
