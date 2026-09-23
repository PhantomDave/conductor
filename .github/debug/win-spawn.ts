// TEMPORARY diagnostic for TODO #2(b) — delete before merge.
const run = `bun -e "console.log('hello from conductor test fixture')"`;
const shell = process.env.COMSPEC ?? "cmd.exe";
const cases: Array<[string, string[], Record<string, unknown>]> = [];
for (const detached of [true, false])
  for (const verbatim of [false, true]) {
    cases.push([`cmd detached=${detached} verbatim=${verbatim}`, [shell, "/c", run], { detached, windowsVerbatimArguments: verbatim }]);
  }
for (const detached of [true, false])
  cases.push([`argv detached=${detached}`, ["bun", "-e", "console.log('hello from conductor test fixture')"], { detached }]);
for (const [label, cmd, opts] of cases) {
  const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", ...opts });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  console.log(`${label}: code=${code} stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err)}`);
}
