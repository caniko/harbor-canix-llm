import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createProjectEnvironments, wrapProjectCommand } from "../src/project-environment.mjs";

const exec = promisify(execFile);
const direnv = process.env.DIRENV_BIN;
const nix = process.env.NIX_BIN;
const integration = { skip: !direnv || !nix, timeout: 30_000 };

async function writableDirectories(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await writableDirectories(path.join(directory, entry.name));
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "project-environment-"));
  t.after(async () => { await writableDirectories(root); await rm(root, { recursive: true, force: true }); });
  const baseline = { ...process.env, HOME: `${root}/home`, XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`, PROJECT_TEST_BASE: "baseline" };
  // Pure fixture flakes need no downloads/builds. A private local store lets
  // the real Nix catalog query run inside the Nix check without its daemon.
  baseline.NIX_CONFIG = `experimental-features = nix-command flakes\nstore = local?root=${root}/nix\n`;
  delete baseline.DIRENV_CONFIG;
  for (const name of Object.keys(baseline)) if (name.startsWith("DIRENV_")) delete baseline[name];
  const system = process.arch === "arm64" ? "aarch64-linux" : "x86_64-linux";
  const projects = ["a", "b"].map((name) => path.join(root, name));
  for (const directory of [...projects, baseline.HOME, baseline.XDG_CONFIG_HOME, baseline.XDG_DATA_HOME]) await mkdir(directory);
  const envrc = (name) => `
export PROJECT_TEST="${name}:\${PROJECT_DEV_SHELL:-default}"
export PROJECT_DEV_SHELL_ACTIVE="\${PROJECT_DEV_SHELL:-default}"
unset PROJECT_TEST_BASE
`;
  for (const project of projects) {
    await writeFile(path.join(project, "flake.nix"), `{ outputs = {self}: { devShells.${system} = let shell = builtins.derivation { name = "fixture-shell"; system = "${system}"; builder = "/bin/sh"; }; in { default = shell; docs = shell; notAShell = null; }; }; }`);
    await writeFile(path.join(project, ".envrc"), envrc(path.basename(project)));
    await exec(direnv, ["allow", project], { env: baseline });
  }
  const environments = createProjectEnvironments({ roots: projects, direnv, nix, system, baseline });
  return { projects, baseline, environments };
}

test("approved direnv default, flake selection, clear and tombstones", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  assert.deepEqual((await environments.list(cwd)).shells, ["default", "docs"]);
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:default");
  await environments.select({ sessionID: "a", cwd, shell: "docs" });
  const selected = await environments.resolve({ sessionID: "a", cwd });
  assert.equal(selected.env.PROJECT_TEST, "a:docs");
  assert.equal(selected.env.PROJECT_TEST_BASE, undefined);
  assert.equal((await environments.resolve({ sessionID: "b", cwd })).env.PROJECT_TEST, "a:default");
  await assert.rejects(environments.select({ sessionID: "a", cwd, shell: "missing" }), /not declared/);
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:docs");
  await environments.clear({ sessionID: "a", cwd });
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:default");
});

test("changed .envrc fails closed and is never auto-approved", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="changed"\n');
  await assert.rejects(environments.resolve({ sessionID: "a", cwd }), /operator approval/);
});

test("non-flake projects retain direnv without invented shell choices", integration, async (t) => {
  const { projects: [cwd], environments } = await fixture(t);
  await rm(path.join(cwd, "flake.nix"));
  assert.deepEqual((await environments.list(cwd)).shells, []);
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "a:default");
});

test("failed selected preparation preserves the previous choice", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t);
  await environments.select({ sessionID: "a", cwd, shell: "docs" });
  await writeFile(path.join(cwd, ".envrc"), `
if [ "$PROJECT_DEV_SHELL" = default ]; then exit 1; fi
export PROJECT_DEV_SHELL_ACTIVE="$PROJECT_DEV_SHELL"
export PROJECT_TEST="$PROJECT_DEV_SHELL"
`);
  await exec(direnv, ["allow", cwd], { env: baseline });
  await assert.rejects(environments.select({ sessionID: "a", cwd, shell: "default" }), /failed/);
  assert.equal((await environments.resolve({ sessionID: "a", cwd })).env.PROJECT_TEST, "docs");
});

test("unacknowledged selection and stale nix-direnv fallback are rejected", integration, async (t) => {
  const { projects: [cwd], baseline, environments } = await fixture(t);
  await writeFile(path.join(cwd, ".envrc"), 'export PROJECT_TEST="ignores-selection"\n');
  await exec(direnv, ["allow", cwd], { env: baseline });
  await assert.rejects(environments.select({ sessionID: "a", cwd, shell: "docs" }), /acknowledge/);
  await writeFile(path.join(cwd, ".envrc"), 'export NIX_DIRENV_DID_FALLBACK=1\n');
  await exec(direnv, ["allow", cwd], { env: baseline });
  await assert.rejects(environments.resolve({ sessionID: "a", cwd }), /stale fallback/);
});

test("two projects in one session are serialized through delegated execution", integration, async (t) => {
  const { projects: [a, b], environments } = await fixture(t);
  const active = new Map();
  const seen = [];
  const execute = wrapProjectCommand({
    directory: a, environments,
    setEnvironment: async (session, env) => { active.set(session, env); },
    execute: async (input, context) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push(active.get(context.sessionID).PROJECT_TEST);
      return input.command;
    },
  });
  const context = { sessionID: "one", signal: new AbortController().signal };
  assert.deepEqual(await Promise.all([
    execute({ command: "a", workdir: a }, context),
    execute({ command: "b", workdir: b }, context),
  ]), ["a", "b"]);
  assert.deepEqual(seen, ["a:default", "b:default"]);
});
