import type { DrushArgs } from '../types.js';

export function buildUserCreateArgs(input: { name: string; email?: string; password?: string }): DrushArgs {
  const args = [input.name];
  if (input.email) args.push(`--mail=${input.email}`);
  if (input.password) args.push(`--password=${input.password}`);
  return { command: 'user:create', args };
}
export function buildUserBlockArgs(input: { name: string }): DrushArgs {
  return { command: 'user:block', args: [input.name] };
}
