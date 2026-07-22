import type { HealthcheckConfig } from "../config/schema";

export interface DockerComposeService {
  image?: string;
  build?: {
    context?: string;
    dockerfile?: string;
    args?: Record<string, string>;
  };
  ports?: (string | number)[];
  environment?: Record<string, string> | string[];
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
 * Converts docker duration strings (e.g. "10s", "1m") to milliseconds
 */
function parseDurationToMs(duration?: string): number | undefined {
  if (!duration) return undefined;

  const match = duration.match(/^(\d+)([smh])$/);
  if (!match) return undefined;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    default:
      return undefined;
  }
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
 * Extracts environment variables (simple extraction, not handling complex interpolation)
 */
function extractEnvironment(env?: Record<string, string> | string[]): Record<string, string> {
  if (!env) return {};

  if (Array.isArray(env)) {
    const result: Record<string, string> = {};
    for (const entry of env) {
      const [key, value] = entry.split("=");
      if (key && value !== undefined) {
        result[key.trim()] = value.trim();
      }
    }
    return result;
  }

  return env;
}

/**
 * Extracts the first exposed port from ports array
 */
function extractFirstPort(ports?: (string | number)[]): number | undefined {
  if (!ports || ports.length === 0) return undefined;

  const firstPort = ports[0];
  if (typeof firstPort === "number") {
    return firstPort;
  }

  if (typeof firstPort === "string") {
    // Handle formats like "5432:5432", "localhost:5432:5432", or just "5432"
    const parts = firstPort.split(":");
    const portStr = parts[parts.length - 1];
    const port = parseInt(portStr, 10);
    return !Number.isNaN(port) ? port : undefined;
  }

  return undefined;
}

/**
 * Extracts URL from a curl/wget healthcheck test command
 * Handles both string and array formats from docker-compose
 */
function extractUrlFromTestCommand(testStr: string): string | undefined {
  // Remove CMD prefix if present (docker-compose adds it sometimes)
  // Also remove brackets and quotes from array format
  const cleanedStr = testStr.replace(/^.*?CMD\s+/, "").replace(/[[\]"']/g, "");

  // Try to extract URL pattern (http://... or https://...)
  const urlRegex = /(https?:\/\/[^\s,]+)/;
  const match = urlRegex.exec(cleanedStr);
  return match ? match[1] : undefined;
}

/**
 * Extracts or infers a health check from the service definition
 */
function extractHealthcheck(service: DockerComposeService): HealthcheckConfig | undefined {
  // If service has explicit healthcheck, map it
  if (service.healthcheck) {
    const interval = parseDurationToMs(service.healthcheck.interval) ?? 1000;
    const timeout = parseDurationToMs(service.healthcheck.timeout) ?? 30000;
    const retries = service.healthcheck.retries ?? 30;

    // Try to infer type and extract URL/command from test command
    let type: "command" | "port" | "http" | "none" = "command";
    let url: string | undefined;
    let command: string | undefined;

    if (service.healthcheck.test) {
      const testStr =
        typeof service.healthcheck.test === "string"
          ? service.healthcheck.test
          : service.healthcheck.test.join(" ");

      if (testStr.includes("curl") || testStr.includes("wget")) {
        type = "http";
        url = extractUrlFromTestCommand(testStr);
      } else {
        command = testStr;
      }
    }

    const result: HealthcheckConfig = {
      type,
      interval_ms: interval,
      timeout_ms: timeout,
      retries,
    };

    if (url) result.url = url;
    if (command) result.command = command;

    return result;
  }

  // Infer from port if available
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
    healthcheck: extractHealthcheck(service),
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
