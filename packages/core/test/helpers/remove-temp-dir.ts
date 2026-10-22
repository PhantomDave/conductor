import { rmSync } from "node:fs";

/**
 * Removes a test's temp dir. Windows lets go of a just-stopped child's cwd and
 * a just-closed SQLite file a moment later (EBUSY/EPERM), and since Bun 1.4.4
 * that moment is often 1.5-2s, sometimes past the retry window. On Windows the
 * dir is then left for the OS temp cleanup instead of failing the test: the
 * tests check themselves that processes are gone, and a temp dir that outlives
 * them is not a product bug. Anywhere else a failure still throws.
 */
export async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw err;
      if (attempt >= 30) {
        if (process.platform === "win32") return;
        throw err;
      }
      await Bun.sleep(100);
    }
  }
}
