#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { parseCliArgs, configPathFromArgs, loadConfigFile, loadConfigFromEnv, mergeConfig, applyCliOverrides } from './config.js';
import { createServer } from './server.js';

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
  --profile <name>        Tools to expose: read-only, content or full (default)
  --run-as <uid>          Account bridge commands act as when the agent names none
                          (default: anonymous)
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
  const config      = applyCliOverrides(mergeConfig(cliConfig, fileConfig, envConfig), args);
  const server      = createServer(config, version);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
