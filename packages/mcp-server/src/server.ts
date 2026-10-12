import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';

import { AuditLog, summarizeArgs } from './audit.js';
import { normalizeError } from './errors.js';
import type { ToolName } from './policy.js';
import { SiteManager } from './site-manager.js';
import { DRUSH_COMMAND_NAME } from './transport/base.js';
import type { DrushArgs, DrushMcpConfig, SiteConfig, TransportResult } from './types.js';
import { resolveFileUploadConfig } from './types.js';

import { buildEntityCreateArgs, buildEntityReadArgs, buildEntityUpdateArgs, buildEntityListArgs, buildEntityDeleteArgs } from './tools/entity.js';
import { buildCacheRebuildArgs, buildWatchdogArgs, buildStatusArgs, buildConfigGetArgs, buildConfigSetArgs, buildFieldInfoArgs } from './tools/system.js';
import { buildUserCreateArgs, buildUserBlockArgs } from './tools/user.js';
import { buildDrushArgs, buildPhpEvalArgs, buildSqlQueryArgs } from './tools/power.js';
import { buildIntrospectArgs } from './tools/introspect.js';
import { buildFileUploadArgs, buildFileAttachArgs, FilePreflightError, type FileUploadInput, type FileAttachInput, type FileDrushArgs } from './tools/file.js';

/**
 * Builds the MCP server for a resolved configuration: every tool, the tool
 * policy of each site and the audit log. Kept apart from the CLI entry point
 * so tests can drive it through an in-memory transport.
 */
export function createServer(config: DrushMcpConfig, version: string): McpServer {
  const siteManager = new SiteManager(config);

  // Resolved up front, so a typo in a profile, a tool name or run_as stops the
  // server here instead of on the first call that reaches it.
  const policies = new Map(siteManager.listNames().map((name) => {
    siteManager.getRunAs(name);
    return [name, siteManager.getToolPolicy(name)] as const;
  }));
  const audit = AuditLog.open(config.defaults?.audit_log);

  const server = new McpServer({
    name: 'drush-mcp',
    version,
  });

  type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

  /** A finished call: what the agent gets back, and what the audit log keeps. */
  interface Outcome {
    result:   ToolResult;
    exitCode: number | null;
    error?:   string;
    refused?: boolean;
  }

  /** A call this server turns away by policy, before anything runs. */
  class Refusal extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  }

  const errorResult = (error: object): ToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
    isError: true,
  });

  // The bridge reports its own errors as JSON on stdout with exit code 0;
  // the agent sees them as before, and the audit log records them as errors.
  function bridgeErrorOf(stdout: string): string | undefined {
    try {
      const parsed = JSON.parse(stdout);
      return parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'string' ? parsed.error : undefined;
    }
    catch {
      return undefined;
    }
  }

  function outcomeOf(result: TransportResult, command: string, siteName: string): Outcome {
    if (result.exitCode !== 0) {
      const error = normalizeError('drush', result.stderr || result.stdout, {
        exitCode: result.exitCode, command, site: siteName,
      });
      return { result: errorResult(error), exitCode: result.exitCode, error: error.error };
    }
    return {
      result:   { content: [{ type: 'text', text: result.stdout || 'OK' }] },
      exitCode: 0,
      error:    bridgeErrorOf(result.stdout),
    };
  }

  /**
   * The account a bridge command runs as: the one the agent named, else the
   * site's run_as, else none, which the bridge takes as anonymous.
   *
   * Outside the full profile the agent may not name an account other than
   * run_as. Drupal's access checks are the boundary of those profiles, and an
   * agent free to pick uid 1 could switch them off.
   */
  function actingUser(siteName: string, requested: unknown, param: string): number | undefined {
    const runAs = siteManager.getRunAs(siteName);
    if (requested === undefined) {
      return runAs;
    }
    const { profile } = policies.get(siteName)!;
    if (profile !== 'full' && requested !== runAs) {
      const who = runAs === undefined ? 'anonymous' : `uid ${runAs}`;
      throw new Refusal('user_not_allowed', `Site '${siteName}' uses the ${profile} tools profile, which runs bridge commands as ${who}; ${param} may not name another account.`);
    }
    return requested as number;
  }

  type Runner = (site: SiteConfig, input: Record<string, unknown>) => Promise<Outcome>;

  /**
   * Registers a tool unless no site enables it, refuses it for a site that
   * switched it off, and writes one audit line per call however it ends.
   */
  function register(name: ToolName, description: string, shape: ZodRawShape, run: Runner): void {
    if (![...policies.values()].some((policy) => policy.enabled.has(name))) {
      return;
    }
    server.tool(name, description, shape, async ({ site, ...input }: Record<string, unknown>) => {
      const started  = Date.now();
      const loggable = summarizeArgs(input);
      let siteName: string | null = null;
      let outcome: Outcome;
      try {
        const siteConfig = siteManager.resolve(site as string | undefined);
        siteName = siteConfig.name;
        const policy = policies.get(siteName)!;
        if (!policy.enabled.has(name)) {
          throw new Refusal('tool_disabled', `${name} is switched off for site '${siteName}' (tools profile ${policy.profile}).`);
        }
        outcome = await run(siteConfig, input);
      }
      catch (err) {
        outcome = err instanceof Refusal
          ? { result: errorResult({ error: err.code, message: err.message, site: siteName }), exitCode: null, error: err.code, refused: true }
          // The shape the SDK gives a thrown error, as before.
          : { result: { content: [{ type: 'text', text: (err as Error).message }], isError: true }, exitCode: null, error: 'exception' };
      }
      audit?.record({
        time:        new Date(started).toISOString(),
        site:        siteName,
        tool:        name,
        args:        loggable,
        outcome:     outcome.refused ? 'refused' : outcome.error ? 'error' : 'ok',
        ...(outcome.error ? { error: outcome.error } : {}),
        exit_code:   outcome.exitCode,
        duration_ms: Date.now() - started,
      });
      return outcome.result;
    });
  }

  function createHandler(builderFn: (input: Record<string, unknown>) => DrushArgs, options: { actsAs?: boolean } = {}): Runner {
    return async (siteConfig, input) => {
      // Coerce JSON strings to objects (MCP clients may serialize records as strings)
      for (const key of ['fields', 'filters']) {
        if (typeof input[key] === 'string') {
          try { input[key] = JSON.parse(input[key] as string); } catch { /* leave as-is */ }
        }
      }
      if (options.actsAs) {
        input = { ...input, user: actingUser(siteConfig.name, input.user, 'user') };
      }
      const transport   = siteManager.getTransport(siteConfig.name);
      const { command, args, jsonFormat } = builderFn(input);
      const drushArgs   = jsonFormat ? [...args, '--format=json'] : args;
      return outcomeOf(await transport.execute(command, drushArgs), command, siteConfig.name);
    };
  }

  function createFileHandler<T extends FileUploadInput>(builderFn: (input: T, fileConfig: ReturnType<typeof resolveFileUploadConfig>) => FileDrushArgs): Runner {
    return async (siteConfig, input) => {
      const fileConfig = siteManager.getFileUploadConfig(siteConfig.name);
      // `uid` is the owner and, unless run_as says otherwise, the acting account.
      const user       = actingUser(siteConfig.name, input.uid, 'uid');

      let built: FileDrushArgs;
      try {
        built = builderFn({ ...input, user } as T, fileConfig);
      }
      catch (err) {
        if (err instanceof FilePreflightError) {
          return { result: errorResult({ error: err.code, message: err.message, site: siteConfig.name }), exitCode: null, error: err.code };
        }
        throw err;
      }

      const transport = siteManager.getTransport(siteConfig.name);
      return outcomeOf(await transport.executeWithStdin(built.command, built.args, built.stdin), built.command, siteConfig.name);
    };
  }

  const siteParam  = z.string().optional().describe('Site name (required when multiple sites configured)');
  const USER_PARAM = 'Drupal user ID to act as; Drupal access checks apply to this account. Default: the site\'s run_as, else anonymous. Sites on the read-only or content tools profile refuse any account other than run_as.';

  // Entity tools
  register(
    'drupal_entity_create',
    'Create a new Drupal entity (node, comment, etc.) from JSON field values',
    {
      entity_type: z.string().describe('Entity type (e.g. node, comment)'),
      bundle:      z.string().describe('Bundle (e.g. article, page)'),
      fields:      z.any().describe('Field values as key-value pairs'),
      user:        z.coerce.number().optional().describe(USER_PARAM),
      site:        siteParam,
    },
    createHandler(buildEntityCreateArgs as (input: Record<string, unknown>) => DrushArgs, { actsAs: true }),
  );

  register(
    'drupal_entity_read',
    'Load a Drupal entity by type and ID, returning all field values as JSON',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      id:          z.coerce.number().describe('Entity ID'),
      user:        z.coerce.number().optional().describe(USER_PARAM),
      site:        siteParam,
    },
    createHandler(buildEntityReadArgs as (input: Record<string, unknown>) => DrushArgs, { actsAs: true }),
  );

  register(
    'drupal_entity_update',
    'Update specific fields on an existing Drupal entity',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      id:          z.coerce.number().describe('Entity ID'),
      fields:      z.any().describe('Field values to update as key-value pairs'),
      user:        z.coerce.number().optional().describe(USER_PARAM),
      site:        siteParam,
    },
    createHandler(buildEntityUpdateArgs as (input: Record<string, unknown>) => DrushArgs, { actsAs: true }),
  );

  register(
    'drupal_entity_list',
    'Query Drupal entities with filters, pagination, and sorting',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      bundle:      z.string().optional().describe('Bundle to filter by'),
      filters:     z.any().optional().describe('Field filters as key-value pairs'),
      limit:       z.coerce.number().optional().describe('Maximum number of results'),
      offset:      z.coerce.number().optional().describe('Number of results to skip'),
      sort:        z.string().optional().describe('Sort field'),
      user:        z.coerce.number().optional().describe(USER_PARAM),
      site:        siteParam,
    },
    createHandler(buildEntityListArgs as (input: Record<string, unknown>) => DrushArgs, { actsAs: true }),
  );

  register(
    'drupal_entity_delete',
    'Delete a Drupal entity by type and ID',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      id:          z.coerce.number().describe('Entity ID'),
      site:        siteParam,
    },
    createHandler(buildEntityDeleteArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  register(
    'drupal_introspect',
    'Discover entity types, bundles, fields, and allowed values',
    {
      entity_type: z.string().optional().describe('Entity type to inspect'),
      bundle:      z.string().optional().describe('Bundle to inspect'),
      user:        z.coerce.number().optional().describe(USER_PARAM),
      site:        siteParam,
    },
    createHandler(buildIntrospectArgs as (input: Record<string, unknown>) => DrushArgs, { actsAs: true }),
  );

  // System tools
  register(
    'drupal_cache_rebuild',
    'Clear all Drupal caches',
    { site: siteParam },
    createHandler(() => buildCacheRebuildArgs()),
  );

  register(
    'drupal_watchdog',
    'View recent Drupal log entries',
    {
      count:    z.coerce.number().optional().describe('Number of log entries to return'),
      severity: z.string().optional().describe('Filter by severity (e.g. error, warning)'),
      site:     siteParam,
    },
    createHandler(buildWatchdogArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  register(
    'drupal_status',
    'Get Drupal site status (version, DB, PHP, etc.)',
    { site: siteParam },
    createHandler(() => buildStatusArgs()),
  );

  register(
    'drupal_config_get',
    'Read a Drupal configuration value',
    {
      name: z.string().describe('Configuration object name (e.g. system.site)'),
      key:  z.string().optional().describe('Specific key within the configuration object'),
      site: siteParam,
    },
    createHandler(buildConfigGetArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  register(
    'drupal_config_set',
    'Write a Drupal configuration value',
    {
      name:  z.string().describe('Configuration object name (e.g. system.site)'),
      key:   z.string().describe('Key within the configuration object'),
      value: z.string().describe('Value to set'),
      site:  siteParam,
    },
    createHandler(buildConfigSetArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  register(
    'drupal_field_info',
    'Get field definitions for an entity type',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      site:        siteParam,
    },
    createHandler(buildFieldInfoArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  // User tools
  register(
    'drupal_user_create',
    'Create a new Drupal user account',
    {
      name:     z.string().describe('Username'),
      email:    z.string().optional().describe('Email address'),
      password: z.string().optional().describe('Password'),
      site:     siteParam,
    },
    createHandler(buildUserCreateArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  register(
    'drupal_user_block',
    'Block a Drupal user account',
    {
      name: z.string().describe('Username to block'),
      site: siteParam,
    },
    createHandler(buildUserBlockArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  // File tools
  const contentBase64Param = z.string().optional().describe(
    'Base64-encoded file bytes. Provide this OR content_path. Prefer content_path when running through an LLM provider, since dense base64 in tool arguments can trigger provider-side safety filters above ~15 KB.',
  );
  const contentPathParam = z.string().optional().describe(
    'Absolute path to a file on the machine running the MCP server (typically your local laptop when using Claude Code). NOT a path on the Drupal server. Provide this OR content_base64. Preferred for files over ~10 KB. The path, symlinks followed, must fall inside the site\'s content_roots (by default only the system temp directory and /tmp) and the file itself must carry an allowed extension; copy the file into /tmp first if it lives elsewhere.',
  );

  register(
    'drupal_file_upload',
    'Upload a file to the Drupal site and create a managed file entity. Returns the new fid, uri, and url. Provide bytes via content_base64 OR a local filesystem path via content_path.',
    {
      content_base64: contentBase64Param,
      content_path:   contentPathParam,
      filename:       z.string().describe('Display filename including extension'),
      scheme:         z.enum(['public', 'private', 'temporary']).optional().describe('Stream wrapper scheme. Default: the system.file default_scheme of the site, so the file lands where the site keeps its files. Pass explicitly only when you need a different one.'),
      destination:    z.string().optional().describe('Directory within the scheme (default: mcp-uploads/<YYYY-MM> in UTC)'),
      uid:            z.coerce.number().optional().describe('Owning user ID (default: site-configured default_uid)'),
      site:           siteParam,
    },
    createFileHandler<FileUploadInput>(buildFileUploadArgs),
  );

  register(
    'drupal_file_attach',
    'Upload a file and attach it to a file/image field on an existing entity in one round trip. Image fields support optional alt and title. Provide bytes via content_base64 OR a local filesystem path via content_path.',
    {
      content_base64: contentBase64Param,
      content_path:   contentPathParam,
      filename:       z.string().describe('Display filename including extension'),
      entity_type:    z.string().describe('Target entity type (e.g. node, comment, media)'),
      entity_id:      z.coerce.number().describe('Target entity ID'),
      field_name:     z.string().describe('Target field name (must be of type file or image)'),
      mode:           z.enum(['append', 'replace']).optional().describe('Append to or replace existing field items (default: append)'),
      alt:            z.string().optional().describe('Alt text (image fields only)'),
      title:          z.string().optional().describe('Title text (image fields only)'),
      scheme:         z.enum(['public', 'private', 'temporary']).optional().describe('Stream wrapper scheme. Default: the uri_scheme setting of the target field, which is what the Drupal upload widget would use. Pass explicitly only when you need to override the field.'),
      destination:    z.string().optional().describe('Directory within the scheme (default: mcp-uploads/<YYYY-MM> in UTC)'),
      uid:            z.coerce.number().optional().describe('Owning user ID (default: site-configured default_uid)'),
      site:           siteParam,
    },
    createFileHandler<FileAttachInput>(buildFileAttachArgs),
  );

  // Power tools
  register(
    'drupal_drush',
    'Run a Drush command by name, with its options and arguments passed separately',
    {
      command:   z.string().regex(DRUSH_COMMAND_NAME, 'command must be a bare Drush command name (e.g. cache:rebuild); pass options and arguments in arguments').describe('Drush command name only (e.g. cache:rebuild, pm:list). Letters, digits, colon, dot, dash and underscore; no spaces, options or shell syntax.'),
      arguments: z.array(z.string()).optional().describe('Additional arguments and flags'),
      format:    z.string().optional().describe('Output format (e.g. json, table, yaml)'),
      site:      siteParam,
    },
    createHandler(buildDrushArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  register(
    'drupal_php_eval',
    'Execute PHP code on the Drupal site',
    {
      code: z.string().describe('PHP code to evaluate'),
      site: siteParam,
    },
    createHandler(buildPhpEvalArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  register(
    'drupal_sql_query',
    'Run a SQL query against the Drupal database',
    {
      query: z.string().describe('SQL query to execute'),
      site:  siteParam,
    },
    createHandler(buildSqlQueryArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  return server;
}
