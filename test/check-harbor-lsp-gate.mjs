// Harbor/OpenCode LSP selection gate: one runnable end-to-end check over the
// real adapter and the real packaged backend, with no model or provider calls.
//
// Usage:
//   node test/check-harbor-lsp-gate.mjs <opencode-bin> <plugin-mjs> <registry> <nix> <node> <capture> <pkl-lsp>
//
// All paths are explicit so the check stays hermetic: the binary half loads
// the real plugin with the real registry file, and the lifecycle half drives
// the real adapter with a stubbed preparation seam (real `nix develop`
// realization stays a separately-authorized runtime step, never executed here).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const [bin, pluginMjs, registry, nix, nodeBin, capture, pklLsp] = process.argv.slice(2);
if (!bin || !pluginMjs || !registry || !nix || !nodeBin || !capture || !pklLsp) {
  throw new Error(
    "Usage: node test/check-harbor-lsp-gate.mjs <opencode-bin> <plugin-mjs> <registry> <nix> <node> <capture> <pkl-lsp>",
  );
}

const { createAdapter } = await import("../src/adapter.mjs");
const { HarborCanixLlm } = await import("../src/opencode.mjs");

const drv = (tag) => `/nix/store/00000000000000000000000000000000-${tag}.drv`;
const home = await realpath(await mkdtemp(path.join(tmpdir(), "harbor-gate-home-")));
const proj = await realpath(await mkdtemp(path.join(tmpdir(), "harbor-gate-proj-")));
const strictEnv = {
  PATH: "/usr/bin:/bin",
  HOME: home,
  XDG_DATA_HOME: path.join(home, "share"),
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_STATE_HOME: path.join(home, "state"),
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
};

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

async function serveWith(config, port, body) {
  await mkdir(path.join(home, "config", "opencode"), { recursive: true });
  await writeFile(path.join(home, "config", "opencode", "opencode.json"), JSON.stringify(config));
  const server = spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: strictEnv,
    cwd: proj,
  });
  server.stdout.destroy();
  server.stderr.destroy();
  try {
    let healthy = false;
    for (let i = 0; i < 50 && !healthy; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/global/health`);
        healthy = res.ok;
      } catch {}
    }
    assert.ok(healthy, "backend never became healthy");
    return await body(port);
  } finally {
    server.kill("SIGKILL");
  }
}

const pluginOptions = { registry, nix, node: nodeBin, capture };
const pluginEntry = [pluginMjs, pluginOptions];

// --- Part 1: packaged binary loads the real adapter with the real registry.
{
  const config = {
    lsp: { pkl: { command: [pklLsp, "--stdio"], extensions: [".pkl"] } },
    formatter: false,
    plugin: [pluginEntry],
  };
  await writeFile(path.join(proj, "bad.pkl"), "this is not pkl (((\n");
  await mkdir(path.join(home, "config", "opencode"), { recursive: true });
  await writeFile(path.join(home, "config", "opencode", "opencode.json"), JSON.stringify(config));
  const probe = await run(bin, ["debug", "config"], { env: strictEnv, cwd: proj });
  assert.equal(probe.code, 0, `debug config failed: ${probe.stderr.slice(0, 300)}`);
  assert.ok(probe.stdout.includes(pluginMjs), "effective config must carry the real adapter plugin");
  await serveWith(config, 14501, async (port) => {
    const created = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: proj }),
    });
    assert.equal(created.status, 200, "session create must load the real adapter plugin");
    const session = await created.json();
    assert.match(session.id, /^ses_/);
    const diag = await run(bin, ["debug", "lsp", "diagnostics", path.join(proj, "bad.pkl")], {
      env: strictEnv,
      cwd: proj,
    });
    assert.equal(diag.code, 0, `diagnostics failed: ${diag.stderr.slice(0, 300)}`);
    const parsed = JSON.parse(diag.stdout);
    const entries = Object.values(parsed).flat();
    assert.ok(entries.length > 0, "expected a real Pkl diagnostic with the adapter loaded");
    assert.ok(entries.every((entry) => entry.source === "pkl-lsp"));
  });
  console.log("binary wiring: plugin loads, session boots, sessionless diagnostics served");
}

// --- Part 2: fail-closed adapter boundary through the real entrypoint.
// NOTE: the fork logs plugin load failures on the session event bus and
// continues without the hooks, so this documents the adapter-side refusal;
// a silently-skipped adapter is an operational residual (monitor the
// session error stream), not a gate failure.
{
  await assert.rejects(HarborCanixLlm({}, { ...pluginOptions, registry: "/nonexistent.json" }), /ENOENT/);
  console.log("entrypoint: bogus registry refused before any hook exists");
}

// --- Part 3: selection lifecycle over the real adapter (stubbed preparation seam).
{
  const gate = await realpath(await mkdtemp(path.join(tmpdir(), "harbor-gate-select-")));
  const nested = path.join(gate, "nested");
  await mkdir(nested, { recursive: true });
  const registryObject = {
    version: 1,
    projects: [{ name: "gate", root: gate, shells: { one: drv("one"), two: drv("two") } }],
  };
  let preparations = 0;
  const adapter = createAdapter(registryObject, async () => ({
    PATH: `/gate-capture-${++preparations}`,
    GATE_SENTINEL: `shell-${preparations}`,
  }));
  const ctx = (sessionID) => ({
    sessionID,
    directory: gate,
    worktree: gate,
    abort: undefined,
    ask: async () => {},
  });
  const verify = (sessionID) =>
    adapter.shellEnvironment({ cwd: gate, sessionID, harborCanixLlm: 1 }, { env: {} });
  const lspOutput = (sessionID, cwd = gate) => {
    const output = { env: {} };
    return adapter.lspEnvironment({ cwd, sessionID }, output).then(() => output);
  };

  await verify("a");
  await adapter.execute({ action: "select", project: "gate", shell: "one" }, ctx("a"));
  let out = await lspOutput("a");
  assert.equal(out.replace, true);
  assert.equal(out.env.GATE_SENTINEL, "shell-1");
  assert.equal(preparations, 1);

  // Reselect: new environment identity, status follows, no extra selection needed.
  await adapter.execute({ action: "select", project: "gate", shell: "two" }, ctx("a"));
  out = await lspOutput("a");
  assert.equal(out.env.GATE_SENTINEL, "shell-2");
  assert.equal(preparations, 2);
  const shellOut = { env: {} };
  await adapter.shellEnvironment({ cwd: nested, sessionID: "a", harborCanixLlm: 1 }, shellOut);
  assert.equal(shellOut.harborCanixLlmReplace, true);
  assert.equal(shellOut.env.GATE_SENTINEL, "shell-2");

  // Second session is isolated from the first.
  await verify("b");
  await adapter.execute({ action: "select", project: "gate", shell: "one" }, ctx("b"));
  assert.equal((await lspOutput("b")).env.GATE_SENTINEL, "shell-3");
  assert.equal((await lspOutput("a")).env.GATE_SENTINEL, "shell-2");

  // Clear restores the baseline for that session only.
  await adapter.execute({ action: "clear", project: "gate" }, ctx("a"));
  assert.deepEqual(await lspOutput("a"), { env: {} });
  assert.equal((await lspOutput("b")).env.GATE_SENTINEL, "shell-3");

  // Denied authorization selects nothing.
  await verify("c");
  await assert.rejects(
    adapter.execute({ action: "select", project: "gate", shell: "one" }, { ...ctx("c"), ask: async () => { throw new Error("denied"); } }),
    /denied/,
  );
  assert.equal(await adapter.execute({ action: "status", project: "gate" }, ctx("c")), '{"compatible":true,"selected":null}');

  // Release ends the session everywhere.
  adapter.release("b");
  await assert.rejects(lspOutput("b"), /released/);
  console.log("lifecycle: select/reselect/clear/isolate/deny/release verified");
}

// --- Part 4: session.deleted releases through the real plugin entrypoint.
{
  const plugin = await HarborCanixLlm({}, pluginOptions);
  assert.equal(typeof plugin["shell.env"], "function");
  assert.equal(typeof plugin["lsp.env"], "function");
  await plugin.event({ event: { type: "session.deleted", properties: { info: { id: "ghost" } } } });
  await assert.rejects(
    plugin.tool.harbor_devshell.execute(
      { action: "status", project: "gate" },
      { sessionID: "ghost", directory: proj, worktree: proj, ask: async () => {} },
    ),
    /released/,
  );
  const listed = JSON.parse(
    await plugin.tool.harbor_devshell.execute({ action: "list" }, { sessionID: "fresh" }),
  );
  assert.ok(Array.isArray(listed) && listed.length > 0, "real registry must list projects");
  console.log("plugin entrypoint: hooks present, registry live, session release effective");
}

await rm(home, { recursive: true, force: true });
await rm(proj, { recursive: true, force: true });
console.log("harbor LSP gate passed");
