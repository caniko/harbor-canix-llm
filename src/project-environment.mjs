import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function revision(file) {
  return createHash("sha256").update(file).update("\n").update(await readFile(file)).digest("hex");
}

export class EnvironmentApprovalRequired extends Error {
  constructor(project, envrc, hash) {
    super(`Project .envrc needs operator approval: ${envrc}`);
    this.name = "EnvironmentApprovalRequired";
    this.project = project;
    this.envrc = envrc;
    this.revision = hash;
  }

  async isCurrent() {
    try { return await realpath(this.envrc) === this.envrc && await revision(this.envrc) === this.revision; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
}
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// Selection metadata only. Every launch asks direnv to evaluate from the
// same baseline; nix-direnv owns its build cache and watch invalidation.
export function createProjectEnvironments({ roots, direnv, nix, system, baseline, direnvApproval = "auto" }) {
  if (!["auto", "manual"].includes(direnvApproval)) throw new Error("direnvApproval must be auto or manual");
  if (!roots?.length || ![...roots, direnv, nix].every((p) => typeof p === "string" && path.isAbsolute(p))) {
    throw new Error("Project environments require absolute roots and executable paths");
  }
  const selections = new Map();
  const base = { ...baseline };
  for (const name of Object.keys(base)) {
    if (name.startsWith("DIRENV_") || name.startsWith("PROJECT_DEV_SHELL") || name === "NIX_DIRENV_DID_FALLBACK") delete base[name];
  }
  const key = (sessionID, root) => {
    if (typeof sessionID !== "string" || !sessionID) throw new Error("Session identity is required");
    return JSON.stringify([sessionID, root]);
  };
  async function run(binary, args, cwd, env, signal) {
    try {
      return (await exec(binary, args, { cwd, env, signal, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
    } catch (error) {
      // Hook output can contain credentials. Never forward stdout/stderr.
      if (signal?.aborted) throw new Error("Project environment preparation cancelled");
      throw new Error(`${path.basename(binary)} failed while preparing the project environment (${error.code ?? "error"})`);
    }
  }
  async function projectAt(cwd) {
    const directory = await realpath(cwd);
    const allowed = await Promise.all(roots.map((root) => realpath(root)));
    const boundary = allowed.filter((root) => inside(root, directory)).sort((a, b) => b.length - a.length)[0];
    if (!boundary) throw new Error("Working directory is outside configured project roots");
    let current = directory;
    for (;;) {
      try {
        if ((await stat(path.join(current, "flake.nix"))).isFile()) return { root: current, cwd: directory, flake: true };
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (current === boundary) break;
      current = path.dirname(current);
    }
    // Non-flake projects may still use direnv, but have no named-shell menu.
    return { root: boundary, cwd: directory, flake: false };
  }
  async function list(cwd, signal) {
    const project = await projectAt(cwd);
    if (!project.flake) return { ...project, shells: [] };
    const names = JSON.parse(await run(nix, [
      "eval", "--no-allow-import-from-derivation", "--no-write-lock-file", "--json",
      `${project.root}#devShells.${system}`, "--apply",
      "shells: builtins.filter (name: let shell = shells.${name}; in builtins.isAttrs shell && (shell.type or null) == \"derivation\") (builtins.attrNames shells)",
    ], project.root, base, signal));
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) throw new Error("Invalid flake shell catalog");
    return { ...project, shells: names };
  }
  async function requireApproval(project, env, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const status = JSON.parse(await run(direnv, ["status", "--json"], project.cwd, env, signal));
      const rc = status.state?.foundRC;
      if (!rc || !inside(project.root, await realpath(rc.path))) throw new Error("Project has no local .envrc; configure it explicitly");
      if (rc.allowed === 0) return;
      if (![1, 2].includes(rc.allowed)) throw new Error("Unknown direnv approval state");
      const file = await realpath(rc.path);
      const approval = new EnvironmentApprovalRequired(project.root, file, await revision(file));
      // direnv 2.37: Allowed=0, NotAllowed=1, explicitly Denied=2.
      if (direnvApproval === "manual" || rc.allowed === 2) throw approval;
      if (!await approval.isCurrent()) continue;
      signal?.throwIfAborted();
      await run(direnv, ["allow", file], project.cwd, env, signal);
      // Re-read native trust after allow; never export based on an old status.
    }
    throw new Error("Project .envrc approval did not stabilize; retry preparation");
  }
  async function capture(project, shell, signal) {
    const env = { ...base, ...(shell === undefined ? {} : { PROJECT_DEV_SHELL: shell }) };
    await requireApproval(project, env, signal);
    let output;
    try { output = await run(direnv, ["export", "json"], project.cwd, env, signal); }
    catch (error) {
      // A definition can change between status and export. Turn a revoked
      // approval into the same barrier; preserve unrelated evaluation errors.
      await requireApproval(project, env, signal);
      throw error;
    }
    const patch = JSON.parse(output);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid direnv environment patch");
    for (const [name, value] of Object.entries(patch)) {
      if (value === null) delete env[name];
      else if (typeof value === "string") env[name] = value;
      else throw new Error("Invalid direnv environment value");
    }
    if (env.NIX_DIRENV_DID_FALLBACK) throw new Error("nix-direnv used a stale fallback; repair the project environment");
    if (shell !== undefined && env.PROJECT_DEV_SHELL_ACTIVE !== shell) {
      throw new Error("Project .envrc did not acknowledge the selected flake shell");
    }
    return Object.freeze(env);
  }
  return {
    list,
    async resolve({ sessionID, cwd, signal }) {
      const project = await projectAt(cwd);
      const shell = selections.get(key(sessionID, project.root));
      if (shell !== undefined && !(await list(cwd, signal)).shells.includes(shell)) throw new Error("Selected shell is no longer in the flake");
      return { ...project, shell: shell ?? null, env: await capture(project, shell, signal) };
    },
    async select({ sessionID, cwd, shell, signal }) {
      const project = await list(cwd, signal);
      if (!project.shells.includes(shell)) throw new Error("Shell is not declared by the project flake");
      const id = key(sessionID, project.root);
      await capture(project, shell, signal);
      selections.set(id, shell);
      return { root: project.root, shell };
    },
    async clear({ sessionID, cwd, signal }) {
      const project = await projectAt(cwd);
      const id = key(sessionID, project.root);
      await capture(project, undefined, signal);
      selections.delete(id);
      return { root: project.root, shell: null };
    },
  };
}

// Reusable preparation barrier; native hooks consume its immutable snapshot.
export function createEnvironmentBarrier({ environments, requestApproval }) {
  const denied = new Set();
  const preparing = new Map();
  const resolve = async (cwd, context) => {
      context.signal?.throwIfAborted();
      let snapshot;
      for (;;) {
        context.signal?.throwIfAborted();
        try {
          snapshot = await environments.resolve({ sessionID: context.sessionID, cwd, signal: context.signal });
          break;
        } catch (error) {
          if (!(error instanceof EnvironmentApprovalRequired) || !requestApproval) throw error;
          const id = JSON.stringify([context.sessionID, error.envrc, error.revision]);
          if (denied.has(id)) throw new Error(`Project environment approval was declined: ${error.envrc}`);
          if (!await error.isCurrent()) continue;
          const answer = await requestApproval({ sessionID: context.sessionID, approval: error, signal: context.signal });
          context.signal?.throwIfAborted();
          if (answer === "deny") {
            denied.add(id);
            throw new Error(`Project environment approval was declined: ${error.envrc}`);
          }
          if (answer !== "retry") throw new Error("Invalid project environment approval response");
          // A form answer is not direnv approval. Resolve again and require
          // the native trust state for the current file before executing.
        }
      }
      context.signal?.throwIfAborted();
      return snapshot;
  };
  return async (cwd, context) => {
    // Serialize preparation only: one pending approval per session, but a
    // running command never holds this queue or mutates another's snapshot.
    const previous = preparing.get(context.sessionID) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => resolve(cwd, context));
    preparing.set(context.sessionID, next);
    try { return await next; }
    finally { if (preparing.get(context.sessionID) === next) preparing.delete(context.sessionID); }
  };
}

// Retained only for the old-wrapper regression tests. The native hook plugin
// above no longer swaps a session-global environment or serializes execution.
export function wrapProjectCommand({ execute, environments, setEnvironment, directory, requestApproval }) {
  const pending = new Map();
  const resolve = createEnvironmentBarrier({ environments, requestApproval });
  return async (input, context) => {
    const previous = pending.get(context.sessionID) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const snapshot = await resolve(path.resolve(directory, input.workdir ?? "."), context);
      await setEnvironment(context.sessionID, snapshot.env, context.signal);
      context.signal?.throwIfAborted();
      // ponytail: serialize foreground calls through completion because the
      // public executor has no atomic spawn-with-env API. Per-invocation
      // native environments are the upgrade path for concurrent execution.
      return execute(input, context);
    });
    pending.set(context.sessionID, next);
    try { return await next; }
    finally { if (pending.get(context.sessionID) === next) pending.delete(context.sessionID); }
  };
}
