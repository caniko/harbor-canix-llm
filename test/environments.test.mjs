import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createEnvironments, parseCapture, prepare, validateRegistry } from "../src/environments.mjs";
import { createAdapter } from "../src/adapter.mjs";

const a = "/nix/store/00000000000000000000000000000000-native.drv";
const b = "/nix/store/11111111111111111111111111111111-docs.drv";
const capture = fileURLToPath(new URL("../src/capture.mjs", import.meta.url));

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "harbor-llm-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"));
  const registry = { version: 1, projects: [{ name: "project", root, shells: { native: a, docs: b } }] };
  return { root, registry };
}

test("registry accepts only named immutable derivations", () => {
  for (const drv of [".#default", "--command", "https://example.org/flake", "/tmp/example.drv", `${a};sh`]) {
    assert.throws(() => validateRegistry({ version: 1, projects: [{ name: "project", root: "/tmp/project", shells: { native: drv } }] }));
  }
  assert.throws(() => validateRegistry({ version: 1, projects: [{ name: "x", root: "/", shells: {} }] }));
});

test("project replacement during approval fails without preparing or replacing selection", async (t) => {
  const { root, registry } = await fixture(t);
  const old = root + "-old";
  t.after(() => rm(old, { recursive: true, force: true }));
  let preparations = 0;
  const manager = createEnvironments(registry, async () => ({ PATH: `/capture-${++preparations}` }));
  const args = { session: "one", project: "project", shell: "native", cwd: root, authorize: async () => {} };
  await manager.select(args);
  await assert.rejects(manager.select({ ...args, shell: "docs", authorize: async () => {
    await rename(root, old);
    await mkdir(root);
  } }), /root changed/);
  assert.equal(preparations, 1);
  assert.equal(manager.status("one", "project").shell, "native");
  await assert.rejects(manager.environment("one", root), /root changed/);
  manager.clear("one", "project");
  await manager.select(args);
  assert.equal(preparations, 2, "replacement roots must not reuse old captures");
});

test("capture runs a fixed target and strips startup injection without revealing values", () => {
  const output = execFileSync(process.execPath, [capture], {
    env: { PATH: "/bin", CARGO_HOME: "/cache/cargo", SECRET_VALUE: "not-for-logs", BASH_ENV: "/evil" },
    encoding: "utf8",
  });
  const env = parseCapture("hook chatter\n" + output);
  assert.equal(env.CARGO_HOME, "/cache/cargo");
  assert.equal(env.BASH_ENV, undefined);
  assert.equal(env.SECRET_VALUE, "not-for-logs");
  assert.throws(() => parseCapture("missing frame"));
  assert.throws(() => parseCapture('\0harbor-canix-llm-v1\0{"PATH":3}\0'));
});

test("switching replaces environments, reuses session cache, and preserves in-flight snapshots", async (t) => {
  const { root, registry } = await fixture(t);
  let preparations = 0;
  let approvals = 0;
  const manager = createEnvironments(registry, async ({ drv }) => {
    preparations++;
    return drv === a ? { PATH: "/native", ONLY_NATIVE: "yes" } : { PATH: "/docs", ONLY_DOCS: "yes" };
  });
  const select = (shell, session = "one") => manager.select({ session, project: "project", shell, cwd: root, authorize: async () => { approvals++; } });
  await select("native");
  const first = manager.environment("one", root);
  await select("docs");
  assert.deepEqual(await first, { PATH: "/native", ONLY_NATIVE: "yes" });
  assert.deepEqual(await manager.environment("one", path.join(root, "nested")), { PATH: "/docs", ONLY_DOCS: "yes" });
  assert.equal(await manager.environment("two", root), undefined);
  await select("native");
  assert.equal(preparations, 2);
  assert.equal(approvals, 3);
  await select("native", "two");
  assert.equal(preparations, 3);
  manager.clear("one", "project");
  assert.equal(await manager.environment("one", root), undefined);
  assert.equal((await manager.environment("two", root)).PATH, "/native");
  manager.release("two");
  await assert.rejects(manager.environment("two", root), /released/);
});

test("denial, failed preparation, and stale identities do not replace the working shell", async (t) => {
  const { root, registry } = await fixture(t);
  let calls = 0;
  const manager = createEnvironments(registry, async ({ drv }) => {
    calls++;
    if (drv === b) throw new Error("preparation failed");
    return { PATH: "/native" };
  });
  const args = { session: "one", project: "project", shell: "native", cwd: root, authorize: async () => {} };
  await assert.rejects(manager.select({ ...args, authorize: async () => { throw new Error("denied"); } }), /denied/);
  assert.equal(calls, 0);
  await manager.select(args);
  await assert.rejects(manager.select({ ...args, shell: "docs" }), /preparation failed/);
  assert.equal(manager.status("one", "project").drv, a);
  await assert.rejects(manager.select({ ...args, shell: "--command sh" }), /not registered/);
  const identities = [];
  const changed = structuredClone(registry);
  changed.projects[0].shells.native = b;
  const newer = createEnvironments(changed, async () => ({ PATH: "/new" }));
  await newer.select({ ...args, authorize: async (id) => identities.push(id) });
  assert.ok(identities[0].endsWith(b));
  assert.equal(newer.status("one", "project").drv, b);
});

test("project escapes, symlink aliases, and sessionless selection fail", async (t) => {
  const { root, registry } = await fixture(t);
  const manager = createEnvironments(registry, async () => ({ PATH: "/native" }));
  const args = { session: "one", project: "project", shell: "native", cwd: root, authorize: async () => {} };
  await assert.rejects(manager.select({ ...args, cwd: path.dirname(root) }), /does not contain/);
  await assert.rejects(manager.select({ ...args, session: "" }), /Session identity/);
  await assert.rejects(manager.environment(undefined, root), /Session identity/);
  const alias = path.join(root, "alias");
  await symlink(path.join(root, "nested"), alias);
  const aliased = structuredClone(registry);
  aliased.projects[0].root = alias;
  await assert.rejects(createEnvironments(aliased, async () => ({})).select({ ...args, cwd: alias }), /canonical/);
});

test("concurrent switches reject rather than racing approvals", async (t) => {
  const { root, registry } = await fixture(t);
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const manager = createEnvironments(registry, async () => ({ PATH: "/native" }));
  const args = { session: "one", project: "project", shell: "native", cwd: root, authorize: async () => waiting };
  const first = manager.select(args);
  await assert.rejects(manager.select(args), /already pending/);
  assert.throws(() => manager.clear("one", "project"), /pending/);
  release();
  await first;
});

test("adapter requires patched boundary and requests exact preparation permission", async (t) => {
  const { root, registry } = await fixture(t);
  const requests = [];
  const adapter = createAdapter(registry, async () => ({ PATH: "/native" }));
  const context = { sessionID: "session", directory: root, ask: async (request) => requests.push(request) };
  const args = { action: "select", project: "project", shell: "native" };
  await assert.rejects(adapter.execute(args, context), /not verified/);
  await assert.rejects(adapter.shellEnvironment({ cwd: root, sessionID: "session" }, { env: {} }), /lacks/);
  await adapter.shellEnvironment({ cwd: root, sessionID: "session", harborCanixLlm: 1 }, { env: {} });
  await adapter.execute(args, context);
  assert.equal(requests[0].permission, "harbor_dev_shell_prepare");
  assert.deepEqual(requests[0].patterns, [`project:native:${a}`]);
  assert.deepEqual(requests[0].always, requests[0].patterns);
  const output = { env: { STALE: "must disappear" } };
  await adapter.shellEnvironment({ cwd: root, sessionID: "session", harborCanixLlm: 1 }, output);
  assert.deepEqual(output.env, { PATH: "/native" });
  assert.equal(output.harborCanixLlmReplace, true);
  const sessionless = { env: {} };
  await adapter.shellEnvironment({ cwd: root, harborCanixLlm: 1 }, sessionless);
  assert.equal(sessionless.harborCanixLlmReplace, undefined);
});

test("real child processes see replacement and removal, not parent mutation", async (t) => {
  const { root, registry } = await fixture(t);
  const manager = createEnvironments(registry, async ({ drv }) => drv === a ? { ONLY_A: "1" } : { ONLY_B: "1" });
  const args = { session: "session", project: "project", cwd: root, authorize: async () => {} };
  await manager.select({ ...args, shell: "native" });
  await manager.select({ ...args, shell: "docs" });
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
    env: await manager.environment("session", root), encoding: "utf8",
  });
  assert.equal(child.status, 0);
  assert.equal(JSON.parse(child.stdout).ONLY_A, undefined);
  assert.equal(JSON.parse(child.stdout).ONLY_B, "1");
  assert.equal(process.env.ONLY_B, undefined);
});

test("preparation rejects arbitrary executables and installables before spawning", async () => {
  await assert.rejects(prepare({ drv: ".#default" }), /Invalid approved/);
  await assert.rejects(prepare({ drv: a, nix: "/bin/sh", node: "/bin/node", capture }), /immutable store/);
});

test("adapter does not share handshakes or accept command arguments", async (t) => {
  const { root, registry } = await fixture(t);
  const adapter = createAdapter(registry, async () => ({ PATH: "/native" }));
  const context = { sessionID: "one", directory: root, ask: async () => {} };
  const args = { action: "select", project: "project", shell: "native" };
  await adapter.shellEnvironment({ cwd: root, harborCanixLlm: 1 }, { env: {} });
  await assert.rejects(adapter.execute(args, context), /not verified/);
  await adapter.shellEnvironment({ cwd: root, sessionID: "one", harborCanixLlm: 1 }, { env: {} });
  await assert.rejects(adapter.execute(args, { ...context, sessionID: "two" }), /not verified/);
  await assert.rejects(adapter.execute({ ...args, command: "sh" }, context), /commands and overrides/);
});

test("deleting a session while preparing cannot resurrect its environment", async (t) => {
  const { root, registry } = await fixture(t);
  let finish;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const preparing = new Promise((resolve) => { finish = resolve; });
  const manager = createEnvironments(registry, async () => { entered(); return preparing; });
  const selection = manager.select({ session: "one", project: "project", shell: "native", cwd: root, authorize: async () => {} });
  await started;
  manager.release("one");
  finish({ PATH: "/native" });
  await assert.rejects(selection, /released/);
});
