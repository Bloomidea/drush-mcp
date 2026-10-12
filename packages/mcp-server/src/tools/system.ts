import type { DrushArgs } from '../types.js';
import { positional } from './args.js';

export function buildCacheRebuildArgs(): DrushArgs {
  return { command: 'cache:rebuild', args: [], jsonFormat: false };
}
export function buildWatchdogArgs(input: { count?: number; severity?: string } = {}): DrushArgs {
  const args: string[] = [];
  if (input.count !== undefined) args.push(`--count=${input.count}`);
  if (input.severity) args.push(`--severity=${input.severity}`);
  return { command: 'watchdog:show', args, jsonFormat: true };
}
export function buildStatusArgs(): DrushArgs {
  return { command: 'core:status', args: [], jsonFormat: true };
}
export function buildConfigGetArgs(input: { name: string; key?: string }): DrushArgs {
  const args = [positional(input.name, 'name')];
  if (input.key) args.push(positional(input.key, 'key'));
  return { command: 'config:get', args, jsonFormat: true };
}
// The value is left alone: a negative number is a legitimate value, and the
// tool already writes any config, so an option there gains nothing.
export function buildConfigSetArgs(input: { name: string; key: string; value: string }): DrushArgs {
  return { command: 'config:set', args: [positional(input.name, 'name'), positional(input.key, 'key'), input.value, '-y'], jsonFormat: false };
}
export function buildFieldInfoArgs(input: { entity_type: string }): DrushArgs {
  return { command: 'field:info', args: [`--entity-type=${input.entity_type}`], jsonFormat: true };
}
