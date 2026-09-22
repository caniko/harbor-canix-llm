import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// Selection metadata only. Every launch asks direnv to evaluate from the
// same baseline; nix-direnv owns its build cache and watch invalidation.
export function createProjectEnvironments({ roots, direnv, nix, system, baseline }) {
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
  async function capture(project, shell, signal) {
    const env = { ...base, ...(shell === undefined ? {} : { PROJECT_DEV_SHELL: shell }) };
    const status = JSON.parse(await run(direnv, ["status", "--json"], project.cwd, env, signal));
    const rc = status.state?.foundRC;
    if (!rc || !inside(project.root, await realpath(rc.path))) throw new Error("Project has no local .envrc; configure it explicitly");
    if (rc.allowed !== 0) throw new Error(`Project .envrc needs operator approval: ${rc.path}`);
    const patch = JSON.parse(await run(direnv, ["export", "json"], project.cwd, env, signal));
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

// A bounded prototype: this wrapper covers the native registered shell tool,
// not user-shell endpoints, PTYs or formatters. Keep it out of production
// until those paths have an equivalent supported interception boundary.
export function wrapProjectCommand({ execute, environments, setEnvironment, directory }) {
  const pending = new Map();
  return async (input, context) => {
    const previous = pending.get(context.sessionID) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      context.signal?.throwIfAborted();
      const cwd = path.resolve(directory, input.workdir ?? ".");
      const snapshot = await environments.resolve({ sessionID: context.sessionID, cwd, signal: context.signal });
      await setEnvironment(context.sessionID, snapshot.env, context.signal);
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
