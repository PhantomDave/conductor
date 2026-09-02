/**
 * Splits a command string into argv-style words, honoring quoting the way a
 * POSIX shell would: single quotes take everything literally, double quotes
 * allow backslash escapes, and a backslash outside quotes escapes the next
 * character. This is what `shell: false` commands are tokenized with —
 * they're exec'd directly (no shell in the middle to do this splitting for
 * us), so a naive `run.split(/\s+/)` breaks any argument containing a
 * space, e.g. `run: 'node "my script.js" --name="a b"'`.
 *
 * This is intentionally minimal (no `$VAR` expansion, no globbing, no
 * command substitution) — it only reproduces the *quoting/escaping* rules,
 * which is all that's needed to correctly tokenize a fixed argv.
 */
// Inside double quotes, POSIX only treats backslash as an escape before
// these characters — before anything else the backslash is literal, so
// e.g. a Windows path like "C:\Users\name" survives intact.
const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

export function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasContent = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        const next = input[i + 1];
        if (DOUBLE_QUOTE_ESCAPABLE.has(next)) {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasContent = true;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      hasContent = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasContent) {
        words.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }

    current += ch;
    hasContent = true;
  }

  if (quote) {
    throw new Error(
      `Unterminated ${quote === '"' ? "double" : "single"} quote in command: ${input}`,
    );
  }

  if (hasContent) words.push(current);
  return words;
}
