#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { parseCliArgs, configPathFromArgs, loadConfigFile, loadConfigFromEnv, mergeConfig } from './config.js';
import { normalizeError } from './errors.js';
import { SiteManager } from './site-manager.js';
import type { DrushArgs } from './types.js';
import { resolveFileUploadConfig } from './types.js';

import { buildEntityCreateArgs, buildEntityReadArgs, buildEntityUpdateArgs, buildEntityListArgs, buildEntityDeleteArgs } from './tools/entity.js';
import { buildCacheRebuildArgs, buildWatchdogArgs, buildStatusArgs, buildConfigGetArgs, buildConfigSetArgs, buildFieldInfoArgs } from './tools/system.js';
import { buildUserCreateArgs, buildUserBlockArgs } from './tools/user.js';
import { buildDrushArgs, buildPhpEvalArgs, buildSqlQueryArgs } from './tools/power.js';
import { buildIntrospectArgs } from './tools/introspect.js';
import { buildFileUploadArgs, buildFileAttachArgs, FilePreflightError, type FileUploadInput, type FileAttachInput, type FileDrushArgs } from './tools/file.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`drush-mcp ${version}\n`);
    process.exit(0);
  }

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`drush-mcp ${version} - MCP server for Drupal via Drush

Usage:
  drush-mcp [options]

Transport (pick one):
  --local                 Local shell transport
  --ssh                   SSH transport
  --docker                Docker transport

Options:
  --command <cmd>         Local command (e.g. "ddev drush")
  --host <host>           SSH/Docker host
  --user <user>           SSH/Docker user
  --root <path>           Drupal root path on remote
  --container <name>      Docker container name
  --container-filter <f>  Docker filter for dynamic container lookup
  --config <path>         Path to config file (ignored when site flags are given)
  --version, -v           Show version
  --help, -h              Show this help

Environment variables:
  DRUSH_MCP_TRANSPORT     local, ssh, or docker
  DRUSH_MCP_HOST          SSH/Docker host
  DRUSH_MCP_USER          SSH/Docker user
  DRUSH_MCP_ROOT          Drupal root path
  DRUSH_MCP_COMMAND       Local command
  DRUSH_MCP_CONTAINER         Docker container name
  DRUSH_MCP_CONTAINER_FILTER  Docker filter expression

Config file:
  drush-mcp.yml in cwd or home dir, or --config <path>. Used only when no
  transport/host flag is given; a site defined by flags takes precedence.
`);
    process.exit(0);
  }

  const cliConfig   = parseCliArgs(args);
  const fileConfig  = loadConfigFile(configPathFromArgs(args));
  const envConfig   = loadConfigFromEnv();
  const config      = mergeConfig(cliConfig, fileConfig, envConfig);
  const siteManager = new SiteManager(config);

  const server = new McpServer({
    name: 'drush-mcp',
    version,
  });

  function createHandler(builderFn: (input: Record<string, unknown>) => DrushArgs) {
    return async ({ site, ...input }: Record<string, unknown>) => {
      // Coerce JSON strings to objects (MCP clients may serialize records as strings)
      for (const key of ['fields', 'filters']) {
        if (typeof input[key] === 'string') {
          try { input[key] = JSON.parse(input[key] as string); } catch { /* leave as-is */ }
        }
      }
      const siteConfig  = siteManager.resolve(site as string | undefined);
      const transport   = siteManager.getTransport(siteConfig.name);
      const { command, args, jsonFormat } = builderFn(input);
      const drushArgs   = jsonFormat ? [...args, '--format=json'] : args;
      const result      = await transport.execute(command, drushArgs);

      if (result.exitCode !== 0) {
        const error = normalizeError('drush', result.stderr || result.stdout, {
          exitCode: result.exitCode, command, site: siteConfig.name,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(error, null, 2) }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: result.stdout || 'OK' }] };
    };
  }

  function createFileHandler<T>(builderFn: (input: T, fileConfig: ReturnType<typeof resolveFileUploadConfig>) => FileDrushArgs) {
    return async ({ site, ...input }: Record<string, unknown>) => {
      const siteConfig = siteManager.resolve(site as string | undefined);
      const fileConfig = resolveFileUploadConfig(siteManager.getSite(siteConfig.name));

      let built: FileDrushArgs;
      try {
        built = builderFn(input as T, fileConfig);
      }
      catch (err) {
        if (err instanceof FilePreflightError) {
          const error = { error: err.code, message: err.message, site: siteConfig.name };
          return { content: [{ type: 'text' as const, text: JSON.stringify(error, null, 2) }], isError: true };
        }
        throw err;
      }

      const transport = siteManager.getTransport(siteConfig.name);
      const result    = await transport.executeWithStdin(built.command, built.args, built.stdin);

      if (result.exitCode !== 0) {
        const error = normalizeError('drush', result.stderr || result.stdout, {
          exitCode: result.exitCode, command: built.command, site: siteConfig.name,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(error, null, 2) }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: result.stdout || 'OK' }] };
    };
  }

  const siteParam = z.string().optional().describe('Site name (required when multiple sites configured)');

  // Entity tools
  server.tool(
    'drupal_entity_create',
    'Create a new Drupal entity (node, comment, etc.) from JSON field values',
    {
      entity_type: z.string().describe('Entity type (e.g. node, comment)'),
      bundle:      z.string().describe('Bundle (e.g. article, page)'),
      fields:      z.any().describe('Field values as key-value pairs'),
      user:        z.coerce.number().optional().describe('Drupal user ID to run as (default: admin)'),
      site:        siteParam,
    },
    createHandler(buildEntityCreateArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
    'drupal_entity_read',
    'Load a Drupal entity by type and ID, returning all field values as JSON',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      id:          z.coerce.number().describe('Entity ID'),
      user:        z.coerce.number().optional().describe('Drupal user ID to run as (default: admin)'),
      site:        siteParam,
    },
    createHandler(buildEntityReadArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
    'drupal_entity_update',
    'Update specific fields on an existing Drupal entity',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      id:          z.coerce.number().describe('Entity ID'),
      fields:      z.any().describe('Field values to update as key-value pairs'),
      user:        z.coerce.number().optional().describe('Drupal user ID to run as (default: admin)'),
      site:        siteParam,
    },
    createHandler(buildEntityUpdateArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
    'drupal_entity_list',
    'Query Drupal entities with filters, pagination, and sorting',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      bundle:      z.string().optional().describe('Bundle to filter by'),
      filters:     z.any().optional().describe('Field filters as key-value pairs'),
      limit:       z.coerce.number().optional().describe('Maximum number of results'),
      offset:      z.coerce.number().optional().describe('Number of results to skip'),
      sort:        z.string().optional().describe('Sort field'),
      user:        z.coerce.number().optional().describe('Drupal user ID to run as (default: admin)'),
      site:        siteParam,
    },
    createHandler(buildEntityListArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
    'drupal_entity_delete',
    'Delete a Drupal entity by type and ID',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      id:          z.coerce.number().describe('Entity ID'),
      site:        siteParam,
    },
    createHandler(buildEntityDeleteArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
    'drupal_introspect',
    'Discover entity types, bundles, fields, and allowed values',
    {
      entity_type: z.string().optional().describe('Entity type to inspect'),
      bundle:      z.string().optional().describe('Bundle to inspect'),
      user:        z.coerce.number().optional().describe('Drupal user ID to run as (default: admin)'),
      site:        siteParam,
    },
    createHandler(buildIntrospectArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  // System tools
  server.tool(
    'drupal_cache_rebuild',
    'Clear all Drupal caches',
    { site: siteParam },
    createHandler(() => buildCacheRebuildArgs()),
  );

  server.tool(
    'drupal_watchdog',
    'View recent Drupal log entries',
    {
      count:    z.coerce.number().optional().describe('Number of log entries to return'),
      severity: z.string().optional().describe('Filter by severity (e.g. error, warning)'),
      site:     siteParam,
    },
    createHandler(buildWatchdogArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
    'drupal_status',
    'Get Drupal site status (version, DB, PHP, etc.)',
    { site: siteParam },
    createHandler(() => buildStatusArgs()),
  );

  server.tool(
    'drupal_config_get',
    'Read a Drupal configuration value',
    {
      name: z.string().describe('Configuration object name (e.g. system.site)'),
      key:  z.string().optional().describe('Specific key within the configuration object'),
      site: siteParam,
    },
    createHandler(buildConfigGetArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
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

  server.tool(
    'drupal_field_info',
    'Get field definitions for an entity type',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      site:        siteParam,
    },
    createHandler(buildFieldInfoArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  // User tools
  server.tool(
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

  server.tool(
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
    'Absolute path to a file on the machine running the MCP server (typically your local laptop when using Claude Code). NOT a path on the Drupal server. Provide this OR content_base64. Preferred for files over ~10 KB.',
  );

  server.tool(
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

  server.tool(
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
  server.tool(
    'drupal_drush',
    'Run any Drush command',
    {
      command:   z.string().describe('Drush command to run (e.g. cache:rebuild)'),
      arguments: z.array(z.string()).optional().describe('Additional arguments and flags'),
      format:    z.string().optional().describe('Output format (e.g. json, table, yaml)'),
      site:      siteParam,
    },
    createHandler(buildDrushArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
    'drupal_php_eval',
    'Execute PHP code on the Drupal site',
    {
      code: z.string().describe('PHP code to evaluate'),
      site: siteParam,
    },
    createHandler(buildPhpEvalArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
    'drupal_sql_query',
    'Run a SQL query against the Drupal database',
    {
      query: z.string().describe('SQL query to execute'),
      site:  siteParam,
    },
    createHandler(buildSqlQueryArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
