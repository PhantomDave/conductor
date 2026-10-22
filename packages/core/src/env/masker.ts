export const MASK = "********";

/** Heuristic used when importing vars without an explicit secret flag. */
export function looksSecret(key: string): boolean {
  return /secret|token|password|key|credential|api_key/i.test(key);
}

/**
 * Returns a copy of `env` with values for any key in `secretKeys` replaced
 * with a mask. Matching is case-insensitive.
 */
export function maskSecrets(
  env: Record<string, string>,
  secretKeys: string[],
): Record<string, string> {
  const secretSet = new Set(secretKeys.map((k) => k.toLowerCase()));
  const masked: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    masked[key] = secretSet.has(key.toLowerCase()) ? MASK : value;
  }

  return masked;
}

/**
 * Merges environment layers in priority order (later layers win):
 * global env -> profile env -> command overrides -> process.env passthrough.
 */
export function mergeEnv(
  ...layers: Array<Record<string, string> | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    Object.assign(result, layer);
  }
  return result;
}

/**
 * Resolves `${VAR}` style references in a single string using values from
 * the given env map, falling back to process.env. Used for env values
 * themselves as well as other config fields that should be able to
 * reference env vars, e.g. a command's `cwd` or a healthcheck's
 * `url`/`command` (see `resolvePath`).
 */
const VAR_RE = /\$\{([A-Z0-9_]+)\}/gi;

export function interpolateString(value: string, env: Record<string, string>): string {
  return value.replace(VAR_RE, (_match, name: string) => {
    return env[name] ?? process.env[name] ?? "";
  });
}

/**
 * Resolves `${VAR}` style references within env values using values from
 * the same env map (and falling back to process.env). References are
 * followed to their final value (`A=${B}`, `B=${C}`), and a reference back
 * into a value being resolved - `PATH=${PATH}:/x` - reads process.env, so it
 * extends the inherited value instead of looping.
 */
export function interpolateEnv(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  const resolving = new Set<string>();

  const resolveKey = (key: string): string => {
    if (Object.hasOwn(resolved, key)) return resolved[key];
    if (!Object.hasOwn(env, key) || resolving.has(key)) return process.env[key] ?? "";
    resolving.add(key);
    resolved[key] = env[key].replace(VAR_RE, (_match, name: string) => resolveKey(name));
    resolving.delete(key);
    return resolved[key];
  };

  for (const key of Object.keys(env)) resolveKey(key);
  return resolved;
}
