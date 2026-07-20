import Anser, { type AnserJsonEntry } from "anser";
import type { CSSProperties, ReactNode } from "react";

const DECORATION_STYLE: Record<string, CSSProperties> = {
  bold: { fontWeight: 700 },
  dim: { opacity: 0.6 },
  italic: { fontStyle: "italic" },
  underline: { textDecoration: "underline" },
  strikethrough: { textDecoration: "line-through" },
};

function entryStyle(entry: AnserJsonEntry): CSSProperties {
  const style: CSSProperties = {};
  if (entry.fg) style.color = `rgb(${entry.fg})`;
  if (entry.bg) style.backgroundColor = `rgb(${entry.bg})`;
  for (const decoration of entry.decorations) {
    Object.assign(style, DECORATION_STYLE[decoration]);
  }
  return style;
}

/**
 * Renders a single log line's raw text (which may contain ANSI SGR escape
 * codes, e.g. from colored npm/dotnet/docker output) into styled spans -
 * so colors/bold/dim survive instead of the raw `\x1b[32m...\x1b[0m`
 * bytes showing up as literal `[32m`/`[0m` text in the UI.
 */
export function renderAnsiLine(text: string, keyPrefix: string): ReactNode {
  const entries = Anser.ansiToJson(text, { use_classes: false, remove_empty: true });
  if (entries.length === 0) return null;

  return entries.map((entry, i) => (
    <span key={`${keyPrefix}-${i}`} style={entryStyle(entry)}>
      {entry.content}
    </span>
  ));
}
