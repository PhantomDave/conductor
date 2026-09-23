import type { LogRow } from "../lib/api";
import { renderAnsiLine } from "../lib/ansi";

/** Monospace log lines with ANSI colours and a red gutter on stderr. */
export function LogLines({ logs }: { logs: LogRow[] }) {
  return (
    <div style={{ fontFamily: "monospace", fontSize: 13, lineHeight: 1.5 }}>
      {logs.map((log) => (
        <div
          key={log.id}
          style={{
            color: "#d4d4d4",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            borderLeft:
              log.stream === "stderr"
                ? "2px solid var(--mantine-color-red-6)"
                : "2px solid transparent",
            paddingLeft: 6,
          }}
        >
          <span style={{ color: "#6a6a6a" }}>
            {new Date(log.timestamp).toLocaleTimeString()}
            {"  "}
          </span>
          {renderAnsiLine(log.message, String(log.id))}
        </div>
      ))}
    </div>
  );
}
