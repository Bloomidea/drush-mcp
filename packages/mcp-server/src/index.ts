#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { parseCliArgs, loadConfigFile, loadConfigFromEnv, mergeConfig } from './config.js';
import { normalizeError } from './errors.js';
import { SiteManager } from './site-manager.js';
import type { DrushArgs } from './types.js';

import { buildEntityCreateArgs, buildEntityReadArgs, buildEntityUpdateArgs, buildEntityListArgs, buildEntityDeleteArgs } from './tools/entity.js';
import { buildCacheRebuildArgs, buildWatchdogArgs, buildStatusArgs, buildConfigGetArgs, buildConfigSetArgs, buildFieldInfoArgs } from './tools/system.js';
import { buildUserCreateArgs, buildUserBlockArgs } from './tools/user.js';
import { buildDrushArgs, buildPhpEvalArgs, buildSqlQueryArgs } from './tools/power.js';
import { buildIntrospectArgs } from './tools/introspect.js';

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
  --config <path>         Path to config file
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
  drush-mcp.yml in cwd or home dir, or --config <path>
`);
    process.exit(0);
  }

  const cliConfig   = parseCliArgs(args);
  const fileConfig  = loadConfigFile();
  const envConfig   = loadConfigFromEnv();
  const config      = mergeConfig(cliConfig, fileConfig, envConfig);
  const siteManager = new SiteManager(config);

  const server = new McpServer({
    name: 'drush-mcp',
    version,
  });

  function createHandler(builderFn: (input: Record<string, unknown>) => DrushArgs) {
    return async ({ site, ...input }: Record<string, unknown>) => {
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

  const siteParam = z.string().optional().describe('Site name (required when multiple sites configured)');

  // Entity tools
  server.tool(
    'drupal_entity_create',
    'Create a new Drupal entity (node, comment, etc.) from JSON field values',
    {
      entity_type: z.string().describe('Entity type (e.g. node, comment)'),
      bundle:      z.string().describe('Bundle (e.g. article, page)'),
      fields:      z.record(z.string(), z.unknown()).describe('Field values as key-value pairs'),
      user:        z.number().optional().describe('Drupal user ID to run as (default: admin)'),
      site:        siteParam,
    },
    createHandler(buildEntityCreateArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
    'drupal_entity_read',
    'Load a Drupal entity by type and ID, returning all field values as JSON',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      id:          z.number().describe('Entity ID'),
      user:        z.number().optional().describe('Drupal user ID to run as (default: admin)'),
      site:        siteParam,
    },
    createHandler(buildEntityReadArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
    'drupal_entity_update',
    'Update specific fields on an existing Drupal entity',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      id:          z.number().describe('Entity ID'),
      fields:      z.record(z.string(), z.unknown()).describe('Field values to update as key-value pairs'),
      user:        z.number().optional().describe('Drupal user ID to run as (default: admin)'),
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
      filters:     z.record(z.string(), z.unknown()).optional().describe('Field filters as key-value pairs'),
      limit:       z.number().optional().describe('Maximum number of results'),
      offset:      z.number().optional().describe('Number of results to skip'),
      sort:        z.string().optional().describe('Sort field'),
      user:        z.number().optional().describe('Drupal user ID to run as (default: admin)'),
      site:        siteParam,
    },
    createHandler(buildEntityListArgs as (input: Record<string, unknown>) => DrushArgs),
  );

  server.tool(
    'drupal_entity_delete',
    'Delete a Drupal entity by type and ID',
    {
      entity_type: z.string().describe('Entity type (e.g. node, user)'),
      id:          z.number().describe('Entity ID'),
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
      user:        z.number().optional().describe('Drupal user ID to run as (default: admin)'),
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
      count:    z.number().optional().describe('Number of log entries to return'),
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
