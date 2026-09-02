import type { HealthcheckConfig } from "../config/schema";

export interface DockerComposeService {
  image?: string;
  build?: {
    context?: string;
    dockerfile?: string;
    args?: Record<string, string>;
  };
  ports?: (string | number)[];
  depends_on?: Record<string, any> | string[];
  healthcheck?: {
    test?: string | string[];
    interval?: string;
    timeout?: string;
    retries?: number;
  };
  profiles?: string[];
}

export interface SuggestedCommand {
  id: string;
  name: string;
  run: string;
  stop_command: string;
  healthcheck?: HealthcheckConfig;
  deps: string[];
  needsBuild: boolean;
  buildContext?: string;
}

/**
 * Converts docker duration strings to milliseconds. Handles simple forms
 * ("10s", "1m") as well as compound/fractional forms Docker itself accepts
 * ("1m30s", "1.5s"). Returns undefined (caller falls back to a default) if
 * nothing in the string matches a recognized unit.
 */
function parseDurationToMs(duration?: string): number | undefined {
  if (!duration) return undefined;

  const unitMs: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };
  const re = /(\d+(?:\.\d+)?)(h|m|s)/g;
  let totalMs = 0;
  let matchedAny = false;
  let match: RegExpExecArray | null;

  while ((match = re.exec(duration)) !== null) {
    matchedAny = true;
    totalMs += parseFloat(match[1]) * unitMs[match[2]];
  }

  return matchedAny ? Math.round(totalMs) : undefined;
}

/**
 * Slugify a service name to create a valid command ID
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Extracts dependencies from depends_on field
 */
function extractDependencies(dependsOn?: Record<string, any> | string[]): string[] {
  if (!dependsOn) return [];

  if (Array.isArray(dependsOn)) {
    return dependsOn.map((dep) => slugify(typeof dep === "string" ? dep : dep.toString()));
  }

  return Object.keys(dependsOn).map((key) => slugify(key));
}

/**
 * Extracts the first exposed port from a compose `ports` array, as the
 * *host*-side port — the side a healthcheck run from the Conductor host can
 * actually reach (see executor/healthcheck.ts's checkPort, which always
 * connects to `localhost`, never into the container network).
 */
function extractFirstPort(ports?: (string | number)[]): number | undefined {
  if (!ports || ports.length === 0) return undefined;

  const firstPort = ports[0];
  if (typeof firstPort === "number") {
    return firstPort;
  }

  if (typeof firstPort === "string") {
    // "5432" (no host mapping)     -> parts.length === 1, use it as-is (best effort)
    // "8080:80" (HOST:CONTAINER)   -> host is parts[0]
    // "127.0.0.1:8080:80"          -> host is parts[1]
    const parts = firstPort.split(":");
    const hostPortStr = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    const port = parseInt(hostPortStr, 10);
    return !Number.isNaN(port) ? port : undefined;
  }

  return undefined;
}

/**
 * Strips docker-compose's `CMD`/`CMD-SHELL` test-command prefix and array
 * brackets/quotes, leaving a string that's directly executable by a shell.
 * Compose's `test:` always starts with one of these two markers (see
 * https://docs.docker.com/reference/compose-file/services/#healthchecktest);
 * without stripping it, "CMD-SHELL pg_isready" would be stored verbatim and
 * fail every probe since "CMD-SHELL" isn't a real binary.
 */
function stripTestPrefix(testStr: string): string {
  return testStr.replace(/^(CMD-SHELL|CMD)\s+/, "").replace(/[[\]"']/g, "");
}

/**
 * Extracts or infers a health check from the service definition.
 *
 * Compose's `healthcheck.test` always runs *inside the container* (see
 * https://docs.docker.com/reference/compose-file/services/#healthchecktest)
 * — it's exercising tools like `pg_isready` or `redis-cli` that are
 * installed in the image, or hitting a port that's only bound inside the
 * container network. Running that same string as a bare host-side shell
 * command (the previous behavior here) is usually just wrong: the tool
 * often isn't installed on the host, and a "localhost" URL in the test
 * refers to the container's own network namespace, not the host's. So an
 * explicit `test` is wrapped in `docker compose exec -T <service>` to run
 * it exactly the way `docker compose`'s own healthcheck would — `-T`
 * disables pseudo-TTY allocation, which is required for a probe run
 * non-interactively.
 *
 * With no explicit test, falls back to inferring a `port` check from the
 * *published* port (see extractFirstPort) — no container-exec is needed
 * for a plain TCP check.
 */
function extractHealthcheck(
  serviceName: string,
  service: DockerComposeService,
): HealthcheckConfig | undefined {
  const hc = service.healthcheck;
  if (hc?.test) {
    const rawTestStr = typeof hc.test === "string" ? hc.test : hc.test.join(" ");
    const testStr = stripTestPrefix(rawTestStr);

    return {
      type: "command",
      command: `docker compose exec -T ${serviceName} ${testStr}`,
      interval_ms: parseDurationToMs(hc.interval) ?? 1000,
      timeout_ms: parseDurationToMs(hc.timeout) ?? 30000,
      retries: hc.retries ?? 30,
    };
  }

  // No usable explicit test (or `healthcheck:` present without one) — fall
  // back to inferring from the published port, same as no healthcheck at all.
  const port = extractFirstPort(service.ports);
  if (port) {
    return {
      type: "port",
      port,
      interval_ms: 1000,
      timeout_ms: 30000,
      retries: 30,
    };
  }

  return undefined;
}

/**
 * Generates a suggested command from a docker compose service
 */
export function suggestCommand(
  serviceName: string,
  service: DockerComposeService,
): SuggestedCommand {
  const id = slugify(serviceName);
  const hasCustomBuild = !!service.build;
  const buildFlag = hasCustomBuild ? " --build" : "";

  return {
    id,
    name: serviceName,
    run: `docker compose up -d${buildFlag} ${serviceName}`,
    stop_command: `docker compose stop ${serviceName}`,
    healthcheck: extractHealthcheck(serviceName, service),
    deps: extractDependencies(service.depends_on),
    needsBuild: hasCustomBuild,
    buildContext: service.build?.context,
  };
}

/**
 * Parses a docker compose YAML object and extracts service suggestions
 * Services with profiles in docker compose are imported normally,
 * but their profile configuration is ignored and they're assigned to the selected profile in Conductor
 */
export function parseDockerCompose(config: any): SuggestedCommand[] {
  if (!config || typeof config !== "object") {
    return [];
  }

  const services = config.services || {};
  if (typeof services !== "object") {
    return [];
  }

  const suggestions: SuggestedCommand[] = [];

  for (const [serviceName, serviceConfig] of Object.entries(services)) {
    if (typeof serviceConfig === "object" && serviceConfig !== null) {
      try {
        const suggested = suggestCommand(serviceName, serviceConfig as DockerComposeService);
        suggestions.push(suggested);
      } catch (err) {
        // Skip services that fail parsing
        console.warn(`Failed to parse service "${serviceName}":`, err);
      }
    }
  }

  return suggestions;
}
