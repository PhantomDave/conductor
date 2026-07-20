import pino from "pino";
import { maskSecrets } from "../env/masker";

export interface LoggerOptions {
  secretKeys?: string[];
  level?: string;
}

/**
 * Creates a pino logger configured for Conductor: pretty output in dev,
 * structured JSON in production, with secret masking applied to any
 * `env` context field.
 */
export function createLogger(options: LoggerOptions = {}) {
  const { secretKeys = [], level = process.env.LOG_LEVEL ?? "info" } = options;

  const hooks = {
    logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => unknown) {
      const [context, ...rest] = args;
      if (context && typeof context === "object" && "env" in context) {
        const ctx = context as Record<string, unknown>;
        ctx.env = maskSecrets(ctx.env as Record<string, string>, secretKeys);
      }
      return method.apply(this, [context, ...rest]);
    },
  };

  if (process.env.NODE_ENV !== "production") {
    try {
      // pino-pretty's transport runs in a worker thread that resolves
      // the module from disk - this fails inside a single-file compiled
      // executable (e.g. the Electron sidecar binary), so fall back to
      // plain structured logging instead of crashing on startup.
      return pino({
        level,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
        hooks,
      });
    } catch {
      // fall through to plain logger below
    }
  }

  return pino({ level, hooks });
}

export type ConductorLogger = ReturnType<typeof createLogger>;
