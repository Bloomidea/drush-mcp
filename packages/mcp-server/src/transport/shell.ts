/**
 * POSIX single-quote escaping for arguments embedded in a remote shell command.
 *
 * Wraps the value in single quotes, where the shell treats every character
 * literally, and splices in any embedded single quote as `'\''` (close, escaped
 * quote, reopen).
 *
 * This deliberately replaces `shell-quote`'s `quote()`, which picks a
 * double-quoted form for values containing both a single quote and whitespace
 * and then escapes `!` as `\!`. Inside double quotes bash only honours a
 * backslash before `$`, backtick, `"`, `\` and newline, so `\!` survives
 * verbatim in the non-interactive shell that ssh spawns: `!==` in PHP code
 * became `\!==` (parse error), and an exclamation mark in a JSON payload with
 * an apostrophe elsewhere was silently stored with a stray backslash.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
