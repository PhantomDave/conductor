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

  // CONDUCTOR_LOG_JSON is a dedicated opt-out for pino-pretty, safe to set
  // on the sidecar's own process without side effects elsewhere. NODE_ENV
  // is kept as a secondary trigger for anyone running the core server
  // directly in a production-like environment - but nothing in Conductor
  // itself should set NODE_ENV just to influence this logger, since
  // env-resolution.ts's baseLayers() inherits the server's own process.env
  // as the base layer for every managed command's environment.
  const wantsJsonLogs =
    process.env.CONDUCTOR_LOG_JSON === "1" || process.env.NODE_ENV === "production";

  if (!wantsJsonLogs) {
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
