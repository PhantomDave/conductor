import { describe, test, expect } from "bun:test";
import { suggestCommand, parseDockerCompose } from "../src/docker-compose/parser";

describe("suggestCommand", () => {
  test("builds a docker compose up/stop pair keyed by the slugified service name", () => {
    const suggestion = suggestCommand("My Service!", { image: "nginx" });
    expect(suggestion.id).toBe("my-service");
    expect(suggestion.name).toBe("My Service!");
    // `run` uses the original service name verbatim (compose needs the real
    // name to resolve it) — only `id` is slugified.
    expect(suggestion.run).toBe("docker compose up -d My Service!");
    expect(suggestion.stop_command).toBe("docker compose stop My Service!");
  });

  test("adds --build and buildContext when the service defines a custom build", () => {
    const suggestion = suggestCommand("api", {
      build: { context: "./api", dockerfile: "Dockerfile.dev" },
    });
    expect(suggestion.needsBuild).toBe(true);
    expect(suggestion.buildContext).toBe("./api");
    expect(suggestion.run).toBe("docker compose up -d --build api");
  });

  test("extracts deps from array-form depends_on", () => {
    const suggestion = suggestCommand("api", { depends_on: ["Db", "Redis Cache"] });
    expect(suggestion.deps).toEqual(["db", "redis-cache"]);
  });

  test("extracts deps from object-form depends_on (long syntax with conditions)", () => {
    const suggestion = suggestCommand("api", {
      depends_on: { db: { condition: "service_healthy" } },
    });
    expect(suggestion.deps).toEqual(["db"]);
  });

  test("has no deps when depends_on is absent", () => {
    const suggestion = suggestCommand("solo", {});
    expect(suggestion.deps).toEqual([]);
  });
});

describe("suggestCommand - healthcheck inference from ports", () => {
  test("probes the host-published port, not the container-internal port", () => {
    // "8080:80" means the container listens on 80, but only 8080 is
    // reachable from the host — which is what Conductor's healthcheck
    // actually probes (packages/core/src/executor/healthcheck.ts connects
    // to localhost from the host, never inside the container).
    const suggestion = suggestCommand("web", { ports: ["8080:80"] });
    expect(suggestion.healthcheck).toEqual({
      type: "port",
      port: 8080,
      interval_ms: 1000,
      timeout_ms: 30000,
      retries: 30,
    });
  });

  test("handles a bare numeric port (host === container)", () => {
    const suggestion = suggestCommand("db", { ports: [5432] });
    expect(suggestion.healthcheck?.port).toBe(5432);
  });

  test("handles the 3-part host-ip:host:container form", () => {
    const suggestion = suggestCommand("db", { ports: ["127.0.0.1:5433:5432"] });
    expect(suggestion.healthcheck?.port).toBe(5433);
  });

  test("produces no healthcheck when there are no ports and no explicit healthcheck", () => {
    const suggestion = suggestCommand("worker", {});
    expect(suggestion.healthcheck).toBeUndefined();
  });
});

describe("suggestCommand - explicit healthcheck", () => {
  test("wraps the test command in `docker compose exec -T <service>` for fidelity with real compose semantics", () => {
    // Compose's `test:` always runs *inside* the container (pg_isready,
    // curl hitting a container-internal port, etc.) — running it bare on
    // the Conductor host would often just fail (tool not installed, wrong
    // network namespace). `exec -T` runs it exactly where compose would.
    const suggestion = suggestCommand("api", {
      healthcheck: {
        test: ["CMD", "curl", "-f", "http://localhost:3000/health"],
        interval: "5s",
        timeout: "2s",
        retries: 5,
      },
    });
    expect(suggestion.healthcheck).toEqual({
      type: "command",
      command: "docker compose exec -T api curl -f http://localhost:3000/health",
      interval_ms: 5000,
      timeout_ms: 2000,
      retries: 5,
    });
  });

  test("strips the CMD-SHELL prefix before wrapping in docker compose exec", () => {
    const suggestion = suggestCommand("db", {
      healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"] },
    });
    expect(suggestion.healthcheck?.type).toBe("command");
    expect(suggestion.healthcheck?.command).toBe(
      "docker compose exec -T db pg_isready -U postgres",
    );
  });

  test("strips a plain CMD prefix too, and addresses the right service", () => {
    const suggestion = suggestCommand("worker", {
      healthcheck: { test: ["CMD", "pg_isready"] },
    });
    expect(suggestion.healthcheck?.command).toBe("docker compose exec -T worker pg_isready");
  });

  test("accepts the test field as a single string", () => {
    const suggestion = suggestCommand("db", {
      healthcheck: { test: "CMD-SHELL pg_isready -U postgres" },
    });
    expect(suggestion.healthcheck?.command).toBe(
      "docker compose exec -T db pg_isready -U postgres",
    );
  });

  test("parses simple s/m/h durations to milliseconds", () => {
    const suggestion = suggestCommand("api", {
      healthcheck: { test: ["CMD", "true"], interval: "10s", timeout: "1m", retries: 3 },
    });
    expect(suggestion.healthcheck?.interval_ms).toBe(10_000);
    expect(suggestion.healthcheck?.timeout_ms).toBe(60_000);
  });

  test("parses compound and fractional durations (1m30s, 1.5s)", () => {
    const suggestion = suggestCommand("api", {
      healthcheck: { test: ["CMD", "true"], interval: "1m30s", timeout: "1.5s" },
    });
    expect(suggestion.healthcheck?.interval_ms).toBe(90_000);
    expect(suggestion.healthcheck?.timeout_ms).toBe(1_500);
  });

  test("falls back to defaults for an unparseable duration instead of throwing", () => {
    const suggestion = suggestCommand("api", {
      healthcheck: { test: ["CMD", "true"], interval: "not-a-duration" },
    });
    expect(suggestion.healthcheck?.interval_ms).toBe(1000);
  });

  test("does not mistake a 'ms' suffix for minutes", () => {
    const suggestion = suggestCommand("api", {
      healthcheck: { test: ["CMD", "true"], interval: "500ms", timeout: "1s500ms" },
    });
    expect(suggestion.healthcheck?.interval_ms).toBe(500);
    expect(suggestion.healthcheck?.timeout_ms).toBe(1_500);
  });

  test("falls back to defaults for a negative duration instead of throwing", () => {
    const suggestion = suggestCommand("api", {
      healthcheck: { test: ["CMD", "true"], interval: "-5s" },
    });
    expect(suggestion.healthcheck?.interval_ms).toBe(1000);
  });

  test("defaults retries to 30 when the compose service doesn't specify one", () => {
    const suggestion = suggestCommand("api", {
      healthcheck: { test: ["CMD", "true"] },
    });
    expect(suggestion.healthcheck?.retries).toBe(30);
  });

  test("falls back to port inference when healthcheck has no usable test", () => {
    // A `healthcheck:` block with no `test` (e.g. only interval overrides,
    // or `disable: true` represented as an empty test) has nothing to wrap
    // in docker compose exec — falling back to the port, same as if there
    // were no healthcheck key at all, beats generating a guaranteed-broken
    // probe with an empty command.
    const suggestion = suggestCommand("db", {
      ports: ["5433:5432"],
      healthcheck: { interval: "5s" },
    });
    expect(suggestion.healthcheck).toEqual({
      type: "port",
      port: 5433,
      interval_ms: 1000,
      timeout_ms: 30000,
      retries: 30,
    });
  });

  test("produces no healthcheck when there's no test and no ports to fall back to", () => {
    const suggestion = suggestCommand("worker", { healthcheck: { interval: "5s" } });
    expect(suggestion.healthcheck).toBeUndefined();
  });
});

describe("parseDockerCompose", () => {
  test("converts every service in a compose document into a suggestion", () => {
    const suggestions = parseDockerCompose({
      services: {
        db: { image: "postgres", ports: ["5432:5432"] },
        api: { build: { context: "." }, depends_on: ["db"] },
      },
    });

    expect(suggestions.map((s) => s.id).sort()).toEqual(["api", "db"]);
    const api = suggestions.find((s) => s.id === "api");
    expect(api?.deps).toEqual(["db"]);
    expect(api?.needsBuild).toBe(true);
  });

  test("returns an empty array for a missing or malformed services block", () => {
    expect(parseDockerCompose({})).toEqual([]);
    expect(parseDockerCompose({ services: "not-an-object" })).toEqual([]);
    expect(parseDockerCompose(null)).toEqual([]);
    expect(parseDockerCompose("not-an-object")).toEqual([]);
  });

  test("skips a malformed individual service instead of failing the whole parse", () => {
    const suggestions = parseDockerCompose({
      services: {
        good: { image: "nginx" },
        bad: "not-an-object",
      },
    });
    expect(suggestions.map((s) => s.id)).toEqual(["good"]);
  });
});
