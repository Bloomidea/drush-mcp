import type { DrushArgs } from '../types.js';

export function buildEntityCreateArgs(input: { entity_type: string; bundle: string; fields: Record<string, unknown>; user?: number }): DrushArgs {
  const args = [`--type=${input.entity_type}`, `--bundle=${input.bundle}`, `--fields=${JSON.stringify(input.fields)}`];
  if (input.user !== undefined) args.push(`--user=${input.user}`);
  return { command: 'mcp:entity-create', jsonFormat: false, args };
}
export function buildEntityReadArgs(input: { entity_type: string; id: number; user?: number }): DrushArgs {
  const args = [`--type=${input.entity_type}`, `--id=${input.id}`];
  if (input.user !== undefined) args.push(`--user=${input.user}`);
  return { command: 'mcp:entity-read', jsonFormat: false, args };
}
export function buildEntityUpdateArgs(input: { entity_type: string; id: number; fields: Record<string, unknown>; user?: number }): DrushArgs {
  const args = [`--type=${input.entity_type}`, `--id=${input.id}`, `--fields=${JSON.stringify(input.fields)}`];
  if (input.user !== undefined) args.push(`--user=${input.user}`);
  return { command: 'mcp:entity-update', jsonFormat: false, args };
}
export function buildEntityListArgs(input: { entity_type: string; bundle?: string; filters?: Record<string, unknown>; limit?: number; offset?: number; sort?: string; user?: number }): DrushArgs {
  const args = [`--type=${input.entity_type}`];
  if (input.bundle) args.push(`--bundle=${input.bundle}`);
  if (input.filters) args.push(`--filters=${JSON.stringify(input.filters)}`);
  if (input.limit !== undefined) args.push(`--limit=${input.limit}`);
  if (input.offset !== undefined) args.push(`--offset=${input.offset}`);
  if (input.sort) args.push(`--sort=${input.sort}`);
  if (input.user !== undefined) args.push(`--user=${input.user}`);
  return { command: 'mcp:entity-list', jsonFormat: false, args };
}
export function buildEntityDeleteArgs(input: { entity_type: string; id: number }): DrushArgs {
  return { command: 'entity:delete', jsonFormat: false, args: [input.entity_type, String(input.id), '-y'] };
}
