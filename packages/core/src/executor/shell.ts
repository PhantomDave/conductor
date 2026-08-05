import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { which } from "bun";

/**
 * Resolves the shell used to run `shell: true` commands and healthchecks.
 *
 * Historically this was hardcoded to `sh`, which ignores whatever
 * interactive shell the user actually has configured (bash/zsh/fish/...)
 * and doesn't exist at all as a bare `sh` on Windows. Instead:
 *  1. If `configuredShell` (from `.conductor.yml`'s `default_shell`,
 *     settable via the UI's Environment tab) is set, use it.
 *  2. Otherwise fall back to the OS default: `$SHELL` on POSIX,
 *     `%COMSPEC%` on Windows.
 *  3. If neither is available, fall back to `/bin/sh` / `cmd.exe`.
 */
export interface ShellCommand {
  bin: string;
  flag: string;
}

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

export function resolveShell(configuredShell?: string): ShellCommand {
  const bin =
    configuredShell?.trim() ||
    (process.platform === "win32" ? process.env.COMSPEC : process.env.SHELL) ||
    (process.platform === "win32" ? "cmd.exe" : "/bin/sh");

  return { bin, flag: flagFor(bin) };
}

export interface ShellOption {
  /** Absolute (or PATH-resolved) path to the shell binary. */
  path: string;
  /** Display name, e.g. "bash", "zsh", "PowerShell". */
  name: string;
}

const POSIX_CANDIDATES = ["bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "sh"];
const WINDOWS_CANDIDATES = ["cmd.exe", "powershell.exe", "pwsh.exe", "bash.exe"];

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

function displayName(path: string): string {
  const base = basename(path).toLowerCase();
  const withoutExt = base.replace(/\.exe$/, "");
  return DISPLAY_NAMES[base] ?? DISPLAY_NAMES[withoutExt] ?? withoutExt;
}

/**
 * Detects shells actually installed on this machine, for the UI's "default
 * shell" picker. Probes a curated list of well-known shell binaries via
 * PATH (rather than trusting `/etc/shells`, which on some systems lists
 * non-shell entries like `screen` for restricted-login purposes) plus
 * whatever `$SHELL`/`%COMSPEC%` currently points at. Best-effort: never
 * throws, just returns whatever it can confirm exists.
 */
export function listAvailableShells(): ShellOption[] {
  const found = new Map<string, ShellOption>();

  const add = (path: string | null | undefined) => {
    if (!path) return;
    const resolved = which(path) ?? (existsSync(path) ? path : null);
    if (!resolved) return;

    // Dedupe by real path so e.g. /bin/bash and /usr/bin/bash (a common
    // symlink pair) don't both show up as separate options.
    let key = resolved;
    try {
      key = realpathSync(resolved);
    } catch {
      // Keep the unresolved path if realpath fails for any reason.
    }
    if (found.has(key)) return;
    found.set(key, { path: resolved, name: displayName(resolved) });
  };

  if (process.platform === "win32") {
    for (const candidate of WINDOWS_CANDIDATES) add(candidate);
    add(process.env.COMSPEC);
  } else {
    for (const candidate of POSIX_CANDIDATES) add(candidate);
    add(process.env.SHELL);
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
