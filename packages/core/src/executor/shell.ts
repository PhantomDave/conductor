/**
 * Resolves the shell used to run `shell: true` commands and healthchecks.
 *
 * Historically this was hardcoded to `sh`, which ignores whatever
 * interactive shell the user actually has configured (bash/zsh/fish/...)
 * and doesn't exist at all as a bare `sh` on Windows. Resolve the OS's
 * actual default shell instead:
 *  - POSIX: `$SHELL` (the login shell Bash/zsh/fish/etc. set for every
 *    interactive session), falling back to `/bin/sh` only if unset.
 *  - Windows: `%COMSPEC%` (the shell Windows itself launches for `cmd`
 *    invocations), falling back to `cmd.exe`.
 */
export interface ShellCommand {
  bin: string;
  flag: string;
}

export function resolveShell(): ShellCommand {
  if (process.platform === "win32") {
    return { bin: process.env.COMSPEC ?? "cmd.exe", flag: "/c" };
  }

  return { bin: process.env.SHELL ?? "/bin/sh", flag: "-c" };
}
