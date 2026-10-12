import type { DrushArgs } from '../types.js';
import { positional } from './args.js';

export function buildUserCreateArgs(input: { name: string; email?: string; password?: string }): DrushArgs {
  const args = [positional(input.name, 'name')];
  if (input.email) args.push(`--mail=${input.email}`);
  if (input.password) args.push(`--password=${input.password}`);
  return { command: 'user:create', args };
}
export function buildUserBlockArgs(input: { name: string }): DrushArgs {
  return { command: 'user:block', args: [positional(input.name, 'name')] };
}
