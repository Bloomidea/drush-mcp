import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { shellQuote } from '../../src/transport/shell.js';

/** Round-trips a value through a non-interactive bash, as ssh does remotely. */
function throughBash(value: string): string {
  return execFileSync('bash', ['-c', `printf '%s' ${shellQuote(value)}`]).toString();
}

describe('shellQuote', () => {
  it('wraps plain values in single quotes', () => {
    expect(shellQuote('--format=json')).toBe(`'--format=json'`);
  });

  it('splices embedded single quotes', () => {
    expect(shellQuote(`d'equipa`)).toBe(`'d'\\''equipa'`);
  });

  const payloads: Array<[string, string]> = [
    ['PHP strict comparison with a single-quoted string', `if ($x !== 2) { echo 'no'; }`],
    ['PHP negation',                                      `if (!empty($node)) { print_r('x'); }`],
    ['JSON with an apostrophe and an exclamation mark',   `--fields={"t":"Reunião d'equipa","b":"Atenção! Já"}`],
    ['backticks, dollars and backslashes',                'echo "$HOME `id` \\ end'],
    ['embedded newline',                                  "line one\nline two"],
  ];

  for (const [label, payload] of payloads) {
    it(`survives a non-interactive bash: ${label}`, () => {
      expect(throughBash(payload)).toBe(payload);
    });
  }

  it('does not escape ! (regression: shell-quote produced \\! inside double quotes)', () => {
    const code = `if ($x !== 2) { echo 'no'; }`;
    expect(shellQuote(code)).not.toContain('\\!');
    expect(throughBash(code)).toContain('!==');
  });
});
