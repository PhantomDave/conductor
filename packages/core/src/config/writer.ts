import { writeFileSync } from "node:fs";
import yaml from "js-yaml";
import type { ConductorConfig } from "./schema";

/**
 * Serializes a validated config back to YAML and writes it to disk.
 * Used whenever the UI mutates profiles/commands, so `.conductor.yml`
 * stays the single source of truth even when edited from the browser.
 */
export function saveConfig(filePath: string, config: ConductorConfig): void {
  const yamlText = yaml.dump(config, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
  });
  writeFileSync(filePath, yamlText, "utf-8");
}
