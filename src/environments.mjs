import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, realpath, stat } from "node:fs/promises";
import path from "node:path";

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const derivation = /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[a-zA-Z0-9+._?=-]+\.drv$/;
const marker = "\0harbor-canix-llm-v1\0";
const protectedVariables = /^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|BASH_FUNC_.*|LD_PRELOAD|LD_AUDIT|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PROMPT_COMMAND|ZDOTDIR)$/;
// ponytail: retain GC roots for the harness lifetime; per-call refcounts if retention becomes costly.
const profileRoots = new Set();
process.once("exit", () => {
  for (const root of profileRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* runtime directory expires at reboot */ }
  }
});

export function validateRegistry(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.projects)) {
    throw new Error("Expected version 1 project registry");
  }
  const names = new Set();
  const roots = new Set();
  for (const project of value.projects) {
    if (!project || !identifier.test(project.name) || names.has(project.name)) {
      throw new Error("Invalid or duplicate project name");
    }
    if (typeof project.root !== "string" || !path.isAbsolute(project.root) || project.root === "/") {
      throw new Error("Project root must be an absolute project directory");
    }
    if (roots.has(path.resolve(project.root))) throw new Error("Duplicate project root");
    if (!project.shells || Array.isArray(project.shells) || typeof project.shells !== "object") {
      throw new Error("Expected named dev shells");
    }
    for (const [name, drv] of Object.entries(project.shells)) {
      if (!identifier.test(name) || typeof drv !== "string" || !derivation.test(drv)) {
        throw new Error("Shells must refer to immutable store derivations");
      }
    }
    names.add(project.name);
    roots.add(path.resolve(project.root));
  }
  return structuredClone(value);
}

export function parseCapture(stdout) {
  const start = stdout.lastIndexOf(marker);
  if (start === -1) throw new Error("Dev shell did not produce an environment capture");
  const end = stdout.indexOf("\0", start + marker.length);
  if (end === -1) throw new Error("Incomplete environment capture");
  let env;
  try {
    env = JSON.parse(stdout.slice(start + marker.length, end));
  } catch {
    throw new Error("Invalid environment capture JSON");
  }
  if (!env || Array.isArray(env) || typeof env !== "object") throw new Error("Invalid captured environment");
  for (const [key, value] of Object.entries(env)) {
    if (protectedVariables.test(key) || key.startsWith("OPENCODE_") || key.startsWith("HARBOR_CANIX_LLM_")) {
      delete env[key];
      continue;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new Error("Invalid captured variable");
    }
  }
  if (!env.PATH) throw new Error("Dev shell has no PATH");
  return Object.freeze(env);
}

// Preparation is a separately authorized build + trusted hook execution, not read-only evaluation.
export async function prepare({ nix, node, capture, drv, cwd, baseline, signal }) {
  if (!derivation.test(drv)) throw new Error("Invalid approved derivation");
  for (const executable of [nix, node, capture]) {
    if (!executable.startsWith("/nix/store/") || path.normalize(executable) !== executable) {
      throw new Error("Preparation executables must be immutable store paths");
    }
  }
  const runtime = `/run/user/${process.getuid()}`;
  const info = await stat(runtime);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || await realpath(runtime) !== runtime) {
    throw new Error("A private, canonical user runtime directory is required for dev-shell GC roots");
  }
  signal?.throwIfAborted();
  const profileRoot = await mkdtemp(path.join(runtime, "harbor-canix-llm-"));
  profileRoots.add(profileRoot);
  const env = { ...baseline };
  for (const key of Object.keys(env)) {
    if (protectedVariables.test(key)) delete env[key];
  }
  const stdout = await new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(nix, ["develop", drv, "--profile", path.join(profileRoot, "environment"), "--command", node, capture], {
      cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let output = "";
    let size = 0;
    let failure;
    let killer;
    const stop = (reason) => {
      failure ??= new Error(reason);
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
        killer ??= setTimeout(() => {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
          // A detached descendant may retain a pipe even after Nix exits.
          child.stdout.destroy();
          child.stderr.destroy();
          signal?.removeEventListener("abort", abort);
          clearTimeout(timer);
          reject(failure);
        }, 3000);
      }
    };
    const abort = () => stop("Dev-shell preparation cancelled");
    const timer = setTimeout(() => stop("Dev-shell preparation timed out"), 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    const consume = (chunk, keep) => {
      size += Buffer.byteLength(chunk);
      if (size > 8 * 1024 * 1024) stop("Dev-shell preparation exceeded output limit");
      else if (keep) output += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => consume(chunk, true));
    child.stderr.on("data", (chunk) => consume(chunk, false));
    child.on("error", () => { failure = new Error("Cannot start dev-shell preparation"); });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killer);
      signal?.removeEventListener("abort", abort);
      // Never include hook output: it can contain credentials.
      if (failure || code !== 0) reject(failure ?? new Error(`Dev-shell preparation failed (${code})`));
      else resolve(output);
    });
  });
  const captured = { ...parseCapture(stdout) };
  // Nix's temporary build directory is gone after preparation exits.
  for (const key of ["TMPDIR", "TMP", "TEMP", "TEMPDIR", "PWD", "OLDPWD", "SHLVL", "_"]) {
    delete captured[key];
  }
  captured.TMPDIR = baseline.TMPDIR || "/tmp";
  return Object.freeze(captured);
}

export function createEnvironments(registry, prepareEnvironment) {
  const config = validateRegistry(registry);
  const selections = new Map();
  const cache = new Map();
  const busy = new Set();
  const released = new Set();

  async function projectAt(name, cwd) {
    const project = config.projects.find((entry) => entry.name === name);
    if (!project) throw new Error("Project is not registered");
    const root = await realpath(project.root);
    if (root !== path.resolve(project.root)) throw new Error("Registry project roots must be canonical, without symlinks");
    const directory = await realpath(cwd);
    if (directory !== root && !directory.startsWith(root + path.sep)) {
      throw new Error("Project does not contain tool working directory");
    }
    const identity = await stat(root);
    if (!identity.isDirectory()) throw new Error("Project root is not a directory");
    return { ...project, root, identity: `${identity.dev}:${identity.ino}` };
  }

  const keyFor = (session, project) => {
    if (typeof session !== "string" || !session) throw new Error("Session identity is required");
    if (released.has(session)) throw new Error("Session has been released");
    return JSON.stringify([session, project]);
  };

  return {
    list: () => structuredClone(config.projects),
    async select({ session, project: name, shell, cwd, authorize, signal }) {
      const key = keyFor(session, name);
      if (busy.has(key)) throw new Error("A shell switch is already pending for this session/project");
      busy.add(key);
      try {
        const project = await projectAt(name, cwd);
        if (!Object.hasOwn(project.shells, shell)) throw new Error("Dev shell is not registered");
        const drv = project.shells[shell];
        // Even a cache hit needs authorization in the requesting session.
        await authorize(`${project.name}:${shell}:${drv}`);
        signal?.throwIfAborted();
        if (released.has(session)) throw new Error("Session has been released");
        if ((await projectAt(name, cwd)).identity !== project.identity) throw new Error("Project root changed during authorization");
        const cacheKey = JSON.stringify([session, project.root, project.identity, drv]);
        let env = cache.get(cacheKey);
        if (!env) {
          env = Object.freeze({ ...await prepareEnvironment({ drv, cwd: project.root, signal }) });
          signal?.throwIfAborted();
          if (released.has(session)) throw new Error("Session has been released");
          if ((await projectAt(name, cwd)).identity !== project.identity) throw new Error("Project root changed during preparation");
          keyFor(session, name);
          cache.set(cacheKey, env);
        }
        keyFor(session, name);
        const selected = Object.freeze({ project: name, shell, drv, root: project.root, identity: project.identity, env });
        selections.set(key, selected);
        return { project: name, shell, drv };
      } finally {
        busy.delete(key);
      }
    },
    status(session, project) {
      const selected = selections.get(keyFor(session, project));
      return selected ? { project, shell: selected.shell, drv: selected.drv } : null;
    },
    clear(session, project) {
      const key = keyFor(session, project);
      if (busy.has(key)) throw new Error("A shell switch is pending");
      selections.delete(key);
    },
    async environment(session, cwd) {
      if (!session) throw new Error("Session identity is required");
      // Snapshot before awaiting filesystem IO; concurrent switches cannot alter this command.
      const candidates = config.projects.map((project) => selections.get(keyFor(session, project.name))).filter(Boolean);
      const directory = await realpath(cwd);
      const matches = candidates.filter((entry) => directory === entry.root || directory.startsWith(entry.root + path.sep));
      if (matches.length > 1) throw new Error("Ambiguous overlapping project environments");
      if (!matches.length) return undefined;
      if ((await projectAt(matches[0].project, cwd)).identity !== matches[0].identity) {
        throw new Error("Selected project root changed; clear and reselect explicitly");
      }
      return { ...matches[0].env };
    },
    release(session) {
      released.add(session);
      for (const key of [...selections.keys()]) if (JSON.parse(key)[0] === session) selections.delete(key);
      for (const key of [...cache.keys()]) if (JSON.parse(key)[0] === session) cache.delete(key);
    },
  };
}
