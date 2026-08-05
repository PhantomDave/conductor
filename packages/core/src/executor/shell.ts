import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { which } from "bun";

/** Resolves the shell used to run `shell: true` commands and healthchecks. */
export interface ShellCommand {
  bin: string;
  flag: string;
}

const POSIX_CANDIDATES = ["bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "sh"];
const WINDOWS_CANDIDATES = ["cmd.exe", "powershell.exe", "pwsh.exe", "bash.exe"];

interface ShellOption {
  path: string;
  name: string;
}

const DISPLAY_NAMES: Record<string, string> = {
  bash: "Bash",
  zsh: "Zsh",
  fish: "Fish",
  dash: "Dash",
  ksh: "Ksh",
  tcsh: "Tcsh",
  csh: "Csh",
  sh: "sh (POSIX default)",
  "cmd.exe": "Command Prompt",
  "powershell.exe": "PowerShell",
  "pwsh.exe": "PowerShell Core",
  "bash.exe": "Git Bash",
};

/** Well-known shell binaries whose CLI flag for "run this string" isn't `-c`. */
const FLAG_OVERRIDES: Record<string, string> = {
  "cmd.exe": "/c",
  cmd: "/c",
  "powershell.exe": "-Command",
  powershell: "-Command",
  "pwsh.exe": "-Command",
  pwsh: "-Command",
};

function flagFor(bin: string): string {
  return FLAG_OVERRIDES[basename(bin).toLowerCase()] ?? "-c";
}

/** Resolves a shell path via `which()` or fallback FS check; returns null if missing. */
function whichOrExists(name: string | null | undefined): string | null {
  if (!name) return null;
  const resolved = (which(name) ?? (existsSync(name) ? name : null)) as string | null;
  return resolved && existsSync(resolved) ? resolved : null;
}

function displayName(path: string): string {
  const base = basename(path).toLowerCase();
  const withoutExt = base.replace(/\.exe$/, "");
  return DISPLAY_NAMES[base] ?? DISPLAY_NAMES[withoutExt] ?? withoutExt;
}

/**
 * Resolves the shell used to run `shell: true` commands and healthchecks.
 *
 * Historically this was hardcoded to `sh`, which ignores whatever
 * interactive shell the user actually has configured (bash/zsh/fish/...)
 * and doesn't exist at all as a bare `sh` on Windows. Instead:
 *  1. If `configuredShell` (from `.conductor.yml`'s `default_shell`,
 *     settable via the UI's Environment tab) is set, use it **if it exists** on disk.
 *  2. Otherwise try `$SHELL` / `%COMSPEC%` if they point to an existing path.
 *  3. Fall back to well-known candidates found via PATH (`which`).
 *  4. Final fallback: `/bin/sh` (POSIX) or `cmd.exe` (Windows).
 *
 * This prevents ENOENT crashes when, e.g., `$SHELL` is set to a non-existent
 * path inside a CI container (e.g. "/bin/bash" on ubuntu-latest where it's at /usr/bin/bash).
 */
export function resolveShell(configuredShell?: string): ShellCommand {
  // 1. Explicit configured shell — verify it exists first
  const explicit = configuredShell?.trim();
  if (explicit) {
    const found = whichOrExists(explicit);
    if (found) return { bin: found, flag: flagFor(found) };
  }

  // 2. Environment variable fallback — verify it exists too
  if (process.platform === "win32") {
    const fromEnv = whichOrExists(process.env.COMSPEC);
    if (fromEnv) return { bin: fromEnv, flag: flagFor(fromEnv) };
    for (const candidate of WINDOWS_CANDIDATES) {
      const found = whichOrExists(candidate);
      if (found) return { bin: found, flag: flagFor(found) };
    }
    return { bin: "cmd.exe", flag: "/c" };
  }

  const fromEnv = whichOrExists(process.env.SHELL);
  if (fromEnv) return { bin: fromEnv, flag: flagFor(fromEnv) };
  for (const candidate of POSIX_CANDIDATES) {
    const found = whichOrExists(candidate);
    if (found) return { bin: found, flag: flagFor(found) };
  }

   return { bin: "/bin/sh", flag: "-c" };
}

/**
 * Detects shells actually installed on this machine, for the UI "default shell" picker.
 * Probes a curated list of well-known shell binaries via PATH (rather than trusting
 * `/etc/shells`, which on some systems lists non-shell entries like `screen` for
 * restricted-login purposes) plus whatever `$SHELL`/`%COMSPEC%` currently points at.
 * Best-effort: never throws, just returns whatever it can confirm exists.
 */
export function listAvailableShells(): ShellOption[] {
  const found = new Map<string, ShellOption>();

  const add = (path: string | null | undefined) => {
    if (!path) return;
    const resolved = which(path) ?? (existsSync(path) ? path : null);
    if (!resolved) return;

    let key = resolved;
    try {
      key = realpathSync(resolved);
    } catch {
      // Keep the unresolved path if realpath fails for any reason.
    }
    if (found.has(key)) return;
    found.set(key, { path: resolved, name: displayName(resolved) });
  };

  const candidates = process.platform === "win32" ? WINDOWS_CANDIDATES : POSIX_CANDIDATES;
  for (const candidate of candidates) add(candidate);
  if (process.platform === "win32") {
    add(process.env.COMSPEC);
  } else {
    add(process.env.SHELL);
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
