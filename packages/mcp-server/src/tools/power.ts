import type { DrushArgs } from '../types.js';

export function buildDrushArgs(input: { command: string; arguments?: string[]; format?: string }): DrushArgs {
  const args = [...(input.arguments ?? [])];
  if (input.format) args.push(`--format=${input.format}`);
  return { command: input.command, args };
}
export function buildPhpEvalArgs(input: { code: string }): DrushArgs {
  return { command: 'php:eval', args: [input.code] };
}
export function buildSqlQueryArgs(input: { query: string }): DrushArgs {
  return { command: 'sql:query', args: [input.query] };
}
