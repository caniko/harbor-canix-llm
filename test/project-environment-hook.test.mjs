import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/project-environment-v2.mjs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

test("native integration registers a shell hook and rejects unsupported execution contexts", async (t) => {
  const before = process.env.OPENCODE_PASSWORD;
  process.env.OPENCODE_PASSWORD = "fixture-only";
  t.after(() => {
    if (before === undefined) delete process.env.OPENCODE_PASSWORD;
    else process.env.OPENCODE_PASSWORD = before;
  });
  let prepare;
  const execute = () => {};
  const shellTool = { id: "native-shell", name: "shell", description: "Native shell", execute };
  const deleted = Promise.withResolvers();
  const dispose = await plugin.setup({
    options: { roots: ["/fixture"], direnv: "/fixture/direnv", nix: "/fixture/nix", system: "x86_64-linux", serverURL: "http://127.0.0.1:1" },
    location: { directory: "/fixture" },
    shell: { hook: async (name, callback) => { assert.equal(name, "create.before"); prepare = callback; } },
    command: { transform: async () => {} },
    tool: { transform: async (register) => register({ list: () => [shellTool], update: (_, change) => change(shellTool) }) },
    event: { async *subscribe({ signal }) {
      yield { type: "session.deleted", data: { sessionID: "ses_deleted" } };
      deleted.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    } },
  });
  assert.equal(shellTool.execute, execute);
  assert.match(shellTool.description, /Set workdir explicitly/);
  t.after(dispose);
  await deleted.promise;
  await assert.rejects(prepare({ sessionID: "ses_deleted", cwd: "/fixture", env: {}, signal: new AbortController().signal }), /unavailable/);
  await assert.rejects(prepare({ cwd: "/fixture", env: {} }), /session-aware native shell hook/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepare({ sessionID: "ses_test", cwd: "/fixture", env: {}, signal: controller.signal }), { name: "AbortError" });
  await dispose();
  await assert.rejects(prepare({ sessionID: "ses_new", cwd: "/fixture", env: {}, signal: new AbortController().signal }), /unavailable/);
});

test("project XDG paths preserve native direnv trust without changing backend storage", {
  skip: !process.env.DIRENV_BIN || !process.env.NIX_BIN,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-xdg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = process.env.OPENCODE_PASSWORD;
  process.env.OPENCODE_PASSWORD = "fixture-only";
  t.after(() => { if (before === undefined) delete process.env.OPENCODE_PASSWORD; else process.env.OPENCODE_PASSWORD = before; });
  const xdg = { XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data` };
  const originalConfig = process.env.XDG_CONFIG_HOME;
  await writeFile(`${root}/.envrc`, 'export PROJECT_XDG_PROBE="approved"\n');
  await promisify(execFile)(process.env.DIRENV_BIN, ["allow", root], { env: { ...process.env, ...xdg } });
  let prepare;
  const dispose = await plugin.setup({
    options: { roots: [root], direnv: process.env.DIRENV_BIN, nix: process.env.NIX_BIN, system: "x86_64-linux", serverURL: "http://127.0.0.1:1", direnvApproval: "manual", projectXdg: xdg },
    location: { directory: root },
    shell: { hook: async (_, callback) => { prepare = callback; } },
    command: { transform: async () => {} },
    tool: { transform: async () => {} },
    event: { async *subscribe({ signal }) { await new Promise(resolve => signal.addEventListener("abort", resolve, {once:true})); } },
  });
  t.after(dispose);
  const invocation = { sessionID: "ses_xdg", cwd: root, env: {}, signal: new AbortController().signal };
  await prepare(invocation);
  assert.equal(invocation.env.PROJECT_XDG_PROBE, "approved");
  assert.equal(invocation.env.XDG_CONFIG_HOME, xdg.XDG_CONFIG_HOME);
  assert.equal(process.env.XDG_CONFIG_HOME, originalConfig);
});

test("uncovered workdirs receive the baseline through the hook without invoking direnv", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = process.env.OPENCODE_PASSWORD;
  process.env.OPENCODE_PASSWORD = "fixture-only";
  t.after(() => { if (before === undefined) delete process.env.OPENCODE_PASSWORD; else process.env.OPENCODE_PASSWORD = before; });
  const logged = [];
  const originalInfo = console.info;
  console.info = (...args) => logged.push(args.join(" "));
  t.after(() => { console.info = originalInfo; });
  const direnvBin = process.env.DIRENV_BIN;
  const xdg = { XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data` };
  if (direnvBin) await Promise.all(Object.values(xdg).map(directory => mkdir(directory, { recursive: true })));
  let prepare;
  const dispose = await plugin.setup({
    // Without DIRENV_BIN the configured direnv path does not exist: reaching
    // it would fail the command, so uncovered launches provably never spawn it.
    options: { roots: [root], direnv: direnvBin ?? "/fixture/direnv", nix: process.env.NIX_BIN ?? "/fixture/nix", system: "x86_64-linux", serverURL: "http://127.0.0.1:1", direnvApproval: "manual", projectXdg: xdg },
    location: { directory: root },
    shell: { hook: async (_, callback) => { prepare = callback; } },
    command: { transform: async () => {} },
    tool: { transform: async () => {} },
    event: { async *subscribe({ signal }) { await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); } },
  });
  t.after(dispose);
  const invocation = { sessionID: "ses_baseline", cwd: os.tmpdir(), env: { TERM: "xterm-256color" }, signal: new AbortController().signal };
  await prepare(invocation);
  assert.equal(invocation.env.TERM, "xterm-256color");
  assert.equal(invocation.env.OPENCODE_TERMINAL, "1");
  assert.ok(logged.some(line => line.includes('"status":"baseline"') && line.includes('"reason":"outside configured project roots"')),
    `baseline fallback must be reported: ${JSON.stringify(logged)}`);
  if (direnvBin) {
    // A covered workdir still goes through preparation and is no fallback.
    logged.length = 0;
    await writeFile(path.join(root, ".envrc"), 'export PROJECT_COVERED="yes"\n');
    await promisify(execFile)(direnvBin, ["allow", root], { env: { ...process.env, ...xdg } });
    const covered = { sessionID: "ses_baseline", cwd: root, env: {}, signal: new AbortController().signal };
    await prepare(covered);
    assert.equal(covered.env.PROJECT_COVERED, "yes");
    assert.ok(!logged.some(line => line.includes('"status":"baseline"')), "covered launches are not fallbacks");
  }
});
