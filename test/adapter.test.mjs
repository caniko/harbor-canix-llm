import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAdapter } from "../src/adapter.mjs";

const a = "/nix/store/00000000000000000000000000000000-native.drv";

async function fixture(t, projects) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "harbor-lsp-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"));
  const registry = { version: 1, projects: projects ?? [{ name: "project", root, shells: { native: a } }] };
  let preparations = 0;
  const adapter = createAdapter(registry, async () => ({ PATH: `/capture-${++preparations}`, LSP_YES: "1" }));
  const select = async (session = "one", cwd = root) => {
    // Selections require a verified replacement contract, established by an
    // ordinary shell-environment resolution first.
    await adapter.shellEnvironment({ cwd, sessionID: session, harborCanixLlm: 1 }, { env: {} });
    return adapter.execute(
      { action: "select", project: "project", shell: "native" },
      { sessionID: session, directory: root, worktree: root, abort: undefined, ask: async () => {} },
    );
  };
  return { root, adapter, select };
}

test("lsp.env is sessionless-safe and empty without selection", async (t) => {
  const { root, adapter } = await fixture(t);
  const output = { env: {} };
  await adapter.lspEnvironment({ cwd: root }, output);
  assert.deepEqual(output, { env: {} });
  await adapter.lspEnvironment({ cwd: root, sessionID: "nobody" }, output);
  assert.deepEqual(output, { env: {} });
});

test("lsp.env replaces the environment after selection", async (t) => {
  const { root, adapter, select } = await fixture(t);
  await select();
  const output = { env: {} };
  await adapter.lspEnvironment({ cwd: path.join(root, "nested"), sessionID: "one" }, output);
  assert.equal(output.replace, true);
  assert.equal(output.env.LSP_YES, "1");
  assert.match(output.env.PATH, /^\/capture-1/);
});

test("lsp.env clear restores the baseline", async (t) => {
  const { root, adapter, select } = await fixture(t);
  await select();
  await adapter.execute({ action: "clear", project: "project" }, { sessionID: "one" });
  const output = { env: {} };
  await adapter.lspEnvironment({ cwd: root, sessionID: "one" }, output);
  assert.deepEqual(output, { env: {} });
});

test("lsp.env selections do not cross sessions", async (t) => {
  const { root, adapter, select } = await fixture(t);
  await select("one");
  const output = { env: {} };
  await adapter.lspEnvironment({ cwd: root, sessionID: "two" }, output);
  assert.deepEqual(output, { env: {} });
});

test("lsp.env outside the project root resolves nothing", async (t) => {
  const { adapter, select } = await fixture(t);
  await select();
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "harbor-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const output = { env: {} };
  await adapter.lspEnvironment({ cwd: outside, sessionID: "one" }, output);
  assert.deepEqual(output, { env: {} });
});

test("overlapping parent/child selections fail closed, never merged", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "harbor-nest-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = path.join(root, "projects", "repos", "owned", "modde-rs");
  await mkdir(child, { recursive: true });
  const registry = {
    version: 1,
    projects: [
      { name: "canix", root, shells: { native: a } },
      { name: "modde-rs", root: child, shells: { native: a } },
    ],
  };
  let preparations = 0;
  const adapter = createAdapter(registry, async () => ({ PATH: `/capture-${++preparations}` }));
  const ctx = { directory: root, worktree: root };
  const verify = async (session) =>
    adapter.shellEnvironment({ cwd: root, sessionID: session, harborCanixLlm: 1 }, { env: {} });
  const pick = async (session, project) => {
    await verify(session);
    return adapter.execute(
      { action: "select", project, shell: "native" },
      { sessionID: session, ...ctx, abort: undefined, ask: async () => {} },
    );
  };
  await pick("one", "canix");
  await pick("one", "modde-rs");
  // Both selections contain the child cwd: resolution must refuse, and the
  // shell hook must refuse the same way.
  await assert.rejects(adapter.lspEnvironment({ cwd: child, sessionID: "one" }, { env: {} }), /clear all but one/);
  await assert.rejects(
    adapter.shellEnvironment({ cwd: child, sessionID: "one", harborCanixLlm: 1 }, { env: {} }),
    /clear all but one/,
  );
  // Clearing the parent restores the child selection.
  await adapter.execute({ action: "clear", project: "canix" }, { sessionID: "one" });
  const output = { env: {} };
  await adapter.lspEnvironment({ cwd: child, sessionID: "one" }, output);
  assert.equal(output.replace, true);
});

test("shell.env behavior is unchanged by the shared lookup", async (t) => {
  const { root, adapter, select } = await fixture(t);
  const output = { env: {} };
  await adapter.shellEnvironment({ cwd: root }, output);
  assert.deepEqual(output, { env: {} });
  await assert.rejects(
    adapter.shellEnvironment({ cwd: root, sessionID: "one" }, { env: {} }),
    /lacks the harbor-canix-llm replacement contract/,
  );
  await select();
  const replaced = { env: {} };
  await adapter.shellEnvironment({ cwd: root, sessionID: "one", harborCanixLlm: 1 }, replaced);
  assert.equal(replaced.harborCanixLlmReplace, true);
  assert.equal(replaced.env.LSP_YES, "1");
});
