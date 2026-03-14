import type { DrushArgs } from '../types.js';

export function buildIntrospectArgs(input: { entity_type?: string; bundle?: string; user?: number } = {}): DrushArgs {
  const args: string[] = [];
  if (input.entity_type) args.push(`--type=${input.entity_type}`);
  if (input.bundle) args.push(`--bundle=${input.bundle}`);
  if (input.user !== undefined) args.push(`--user=${input.user}`);
  return { command: 'mcp:introspect', args };
}
