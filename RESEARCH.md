# Research: Command Movement/Duplication & docker compose Extraction

## Request 1: Move/Duplicate Commands Between Profiles

### Current State

✅ **DOABLE - Relatively straightforward to implement**

#### What exists now:
- **API layer** (`packages/core/src/api.ts`):
  - `POST /api/profiles/:profile/commands` — Creates a command in a profile
  - `PUT /api/profiles/:profile/commands/:id` — Updates a command
  - `DELETE /api/profiles/:profile/commands/:id` — Deletes a command

- **Store layer** (`packages/core/src/config/store.ts`):
  - `addCommand(profileName, input)` — Adds a command to a profile
  - `removeCommand(profileName, commandId)` — Removes a command from a profile
  - `updateCommand(profileName, commandId, patch)` — Updates a command

- **UI layer** (`packages/ui/src/hooks/useConfig.ts`):
  - `useCreateCommand()` — React hook for creating commands
  - `useDeleteCommand()` — React hook for deleting commands
  - `useUpdateCommand()` — React hook for updating commands

#### Implementation Path:

**Option A: Duplicate (simpler)**
1. Add a new API endpoint: `POST /api/profiles/:profile/commands/:sourceId/duplicate`
2. Backend logic:
   - Fetch the source command from any profile
   - Generate a new ID (slugify + random suffix if collision)
   - Insert as new command in target profile
3. UI: Add "Duplicate to..." context menu on each command

**Option B: Move (with delete)**
1. Add endpoint: `POST /api/profiles/:profile/commands/:sourceId/move-to`
2. Backend logic:
   - Fetch source command
   - Insert into target profile
   - Delete from source profile (in same transaction for atomicity)
3. UI: Add "Move to..." modal picker

**Option C: Bulk copy (more powerful)**
1. Add endpoint: `POST /api/profiles/:sourceProfile/commands/copy-many`
   - Body: `{ targetProfile: string; commandIds: string[] }`
2. Supports copying multiple commands at once

**Recommended: Do both A + B**

The implementation footprint is small:
- **Backend**: ~50-100 LOC total in `store.ts` + ~30 LOC API endpoints
- **UI**: ~200-300 LOC for context menus + confirmation modals
- **Hooks**: Reuse existing `useCreateCommand`/`useDeleteCommand` with minimal new hooks

---

## Request 2: Extract Steps from docker compose to Populate Commands

### Current State

⚠️ **PARTIALLY FEASIBLE - Significant implementation effort, useful for 60-70% of cases**

#### What's technically possible:

✅ **Easy to parse:**
- Service names → Command IDs
- Service image names → Detection of "custom" vs "official" images
- Port mappings → Extraction for health checks (`type: port`)
- Environment variables → Populate `env_overrides`
- Depends_on → Map to `deps` field
- Healthchecks (docker compose spec) → Map to Conductor `healthcheck`
- Build context (if present) → Detect if image needs building

✅ **Medium difficulty:**
- Infer start command: `docker compose up -d <service-name>` (deterministic)
- Infer stop command: `docker compose stop <service-name>` (deterministic)
- Infer health checks from docker compose `healthcheck` spec (when present)
- Parse `build.context` and `build.dockerfile` to infer if a build is needed

❌ **Hard/impossible:**
- Extract or infer `stop_signal` (must stay as default unless explicitly set in compose)
- Infer `stop_timeout_ms` (docker compose doesn't expose stop timeout in standard way)
- Complex custom build logic (build args, conditionals, etc.)
- Multi-stage builds (can detect but not fully parse)

#### docker compose Schema Relevant Fields:

```yaml
services:
  postgres:
    image: postgres:15                      # Detect "official" vs custom
    # OR
    build:
      context: ./services/postgres          # Custom image — needs building
      dockerfile: Dockerfile
      args:
        NODE_ENV: development               # Build args
    ports:
      - "5432:5432"                         # Extract for port health checks
    environment:
      POSTGRES_PASSWORD: secret             # Could populate env_overrides
    depends_on:
      redis:                                # Map to deps: [redis]
        condition: service_healthy
    healthcheck:                            # Map to conductor healthcheck
      test: ["CMD", "pg_isready"]
      interval: 10s
      timeout: 5s
      retries: 5
```

#### What can be extracted:

1. **Service name** → `command.id`
2. **Image or build.context** → `command.name` + detection logic
3. **build context present?** → Flag "needs build" (helps CI/CD)
4. **ports** → `healthcheck.type: port` + `healthcheck.port`
5. **healthcheck spec** → `healthcheck.type`, `healthcheck.command`, etc.
6. **depends_on** → `deps: [...]` (with careful ordering for startup)
7. **environment** → `env_overrides` (but only non-secrets)
8. **start command** → Auto-generated: `docker compose up -d <service>`
9. **stop command** → Auto-generated: `docker compose stop <service>`

---

## Implementation Strategy

### Phase 1: Command Movement (Simpler, ship first)

#### New API endpoints:
```typescript
// Duplicate a command to another profile
POST /api/profiles/:sourceProfile/commands/:commandId/duplicate
Body: { targetProfile: string }
Response: { command: CommandInfo }

// Move a command to another profile
POST /api/profiles/:sourceProfile/commands/:commandId/move
Body: { targetProfile: string }
Response: { command: CommandInfo } (in new profile)

// (Optional) Bulk copy
POST /api/profiles/:sourceProfile/commands/copy-many
Body: { targetProfile: string; commandIds: string[] }
Response: { commands: CommandInfo[] }
```

#### Store methods:
```typescript
duplicateCommand(sourceProfile: string, commandId: string, targetProfile: string): CommandConfig
moveCommand(sourceProfile: string, commandId: string, targetProfile: string): CommandConfig
```

#### UI components:
- Right-click context menu on commands → "Duplicate to..." / "Move to..."
- Modal to pick target profile
- Toast notifications for success/error

---

### Phase 2: docker compose Extraction (More complex, ship later)

#### New API endpoint:
```typescript
// Parse a docker compose.yml file and suggest commands
POST /api/docker compose/parse
Body: {
  yaml: string;              // Raw docker compose.yml content
  profile: string;           // Target profile to populate
  autoImport?: boolean;      // If true, auto-create commands; else return preview
}
Response: {
  commands: Array<{
    id: string;
    name: string;
    run: string;
    stop_command: string;
    healthcheck?: HealthcheckInfo;
    needsBuild?: boolean;
    buildContext?: string;
  }>;
  warnings: string[];        // e.g., "service 'web' has no healthcheck"
}
```

#### New utility module: `packages/core/src/docker compose/parser.ts`
```typescript
export interface DockerComposeService {
  image?: string;
  build?: { context?: string; dockerfile?: string; args?: Record<string, string> };
  ports?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, any> | string[];
  healthcheck?: DockerHealthcheck;
}

export function parseDockerCompose(yaml: string): Record<string, DockerComposeService>

export function suggestCommand(
  serviceName: string,
  service: DockerComposeService,
  composeFilePath?: string
): {
  id: string;
  name: string;
  run: string;
  stop_command: string;
  healthcheck?: HealthcheckInfo;
  needsBuild: boolean;
  buildContext?: string;
}
```

#### Logic:

```typescript
function suggestCommand(serviceName, service, composeDir = ".") {
  const isCustomImage = !!service.build;
  const imageDisplay = service.image || service.build?.context || "unknown";
  
  // Extract port if available
  let healthcheck;
  if (service.ports?.length) {
    const firstPort = service.ports[0].split(":")[1] || service.ports[0].split(":")[0];
    const port = parseInt(firstPort);
    if (!Number.isNaN(port)) {
      healthcheck = {
        type: "port",
        port,
        interval_ms: 1000,
        timeout_ms: 30000,
        retries: 30,
      };
    }
  }
  
  // Map docker healthcheck to conductor
  if (service.healthcheck && !healthcheck) {
    const interval = parseTimeout(service.healthcheck.interval) ?? 1000;
    const timeout = parseTimeout(service.healthcheck.timeout) ?? 30000;
    const retries = service.healthcheck.retries ?? 30;
    
    healthcheck = {
      type: "command",
      command: buildHealthcheckCommand(serviceName),
      interval_ms: interval,
      timeout_ms: timeout,
      retries,
    };
  }
  
  return {
    id: slugify(serviceName),
    name: serviceName,
    run: `docker compose up -d ${serviceName}`,
    stop_command: `docker compose stop ${serviceName}`,
    healthcheck,
    needsBuild: isCustomImage,
    buildContext: service.build?.context,
  };
}
```

#### UI workflow:
1. Add "Import from docker compose.yml" button in CommandLibrary
2. Show file picker or paste YAML textarea
3. Display preview table of detected services + flags
4. Allow check/uncheck to select which to import
5. Display "⚠️ Needs build" badge for custom images
6. Batch-create commands on confirm

---

## Feasibility Assessment

### Command Movement: **✅ HIGHLY FEASIBLE**
- Complexity: Low
- Risk: Very Low
- Implementation time: 2-4 hours
- Benefits: Immediate productivity gain for users
- Dependencies: None (uses existing infrastructure)

### docker compose Extraction: **⚠️ PARTIALLY FEASIBLE**
- Complexity: Medium
- Risk: Medium (parsing is straightforward, but edge cases abound)
- Implementation time: 8-16 hours
- Benefits: Nice-to-have, saves ~5-10 minutes per service
- Dependencies: `js-yaml` (already in package)
- Caveats:
  - Multi-container-per-compose-file is well-supported
  - Complex build logic (conditional builds, build args interpolation) is tricky
  - Healthcheck inference works best if docker compose already has them defined
  - Network isolation, volumes, etc. are **not** directly translatable to Conductor

### Hybrid approach: **✅ RECOMMENDED**
1. **Ship Phase 1 first** (movement) — fast win, low risk
2. **Then ship Phase 2** (extraction) — requires more careful testing, but adds real value
3. **Start with "preview mode"** for extraction — users see suggestions without auto-import, can refine
4. **Iterate on edge cases** based on real-world docker compose files

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Command IDs collide after duplication | High | Auto-suffix with `-copy`, `-copy-2`, etc. |
| User moves command, breaks deps in source | Medium | Validation: warn if other commands dep on this |
| docker compose parsing fails on exotic YAML | Medium | Wrap parser in try-catch, show user-friendly error + raw YAML for manual editing |
| Build detection is wrong (false positive) | Low | Just a hint; user can review; not enforced |
| Healthcheck inference is inaccurate | Medium | Show "preview" mode first; user can override before saving |
| User imports 50 services at once | Low | Batch endpoint handles it; UI can paginate or warn |

---

## File Structure (if implemented)

```
packages/core/src/
├── docker compose/
│   └── parser.ts              # New: docker compose parsing logic
├── config/
│   ├── store.ts               # Modify: Add duplicate/move methods
│   └── schema.ts              # (no changes needed)
└── api.ts                      # Modify: Add new endpoints

packages/ui/src/
├── components/
│   ├── CommandLibrary.tsx      # Modify: Add context menu
│   └── DockerComposeImporter.tsx  # New: Modal for parsing + preview
├── hooks/
│   └── useConfig.ts            # Modify: Add new mutation hooks
└── lib/
    └── api.ts                  # Modify: Add new fetch functions
```

---

## Conclusion

| Feature | Doable? | Effort | Recommend? |
|---------|---------|--------|-----------|
| **Move commands between profiles** | ✅ Yes | Low | 🟢 YES - Ship Phase 1 |
| **Duplicate commands** | ✅ Yes | Low | 🟢 YES - Ship Phase 1 |
| **Extract start/stop/healthcheck from docker compose** | ✅ Mostly | Medium | 🟡 MAYBE - Ship Phase 2 if time permits |
| **Detect custom images & build requirement** | ✅ Yes | Low | 🟢 YES - Include in Phase 2 |

**Recommendation:** Start with command movement (Phase 1), which is quick and solves an immediate UX need. Then if time/resources allow, tackle docker compose extraction as Phase 2.
