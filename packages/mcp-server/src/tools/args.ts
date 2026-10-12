/**
 * Guards a value the agent supplies for a positional slot of a Drush command.
 *
 * Drush reads a leading dash as an option wherever it appears, and its global
 * options change which site runs (`--root`, `--uri`) or what code loads
 * (`--include`). Values passed as `--name=value` need no guard: the agent's
 * text can only ever be the value.
 */
export function positional(value: string, name: string): string {
  if (value.startsWith('-')) {
    throw new Error(`${name} must not start with "-": Drush would read it as an option.`);
  }
  return value;
}
