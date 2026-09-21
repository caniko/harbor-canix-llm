// Lifecycle manager for one pkl-lsp server per session and project root.
//
// Uses vscode-jsonrpc for framing and correlation. The caller supplies
// environment resolution; the resolved environment is used exactly — a
// resolution failure never falls back and never spawns a server.
//
// Document positions are 1-based lines and 1-based UTF-16 columns, converted
// to the 0-based LSP encoding at the boundary. Diagnostics are explicit
// results: an empty diagnostic set, a timeout, and an unsupported server are
// three different answers, never conflated.
import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from "vscode-jsonrpc/node.js";

async function canonicalUnder(root, file) {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file).catch(() => path.resolve(file))]);
  const relative = path.relative(realRoot, realFile);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`pkl file escapes the project root: ${file}`);
  }
  return { root: realRoot, file: realFile, uri: pathToFileURL(realFile).href };
}

function abortError() {
  const error = new Error("pkl request was cancelled");
  error.code = "cancelled";
  return error;
}

export function createPklServers({ executable, args = [], timeoutMs = 30_000, stopGraceMs = 5_000 } = {}) {
  if (!executable) throw new Error("pkl server executable is required");
  const servers = new Map();
  const chains = new Map();
  let disposed = false;

  function key(sessionID, root) {
    if (!sessionID) throw new Error("pkl server identity requires a session");
    return `${sessionID}::${root}`;
  }

  function alive(entry) {
    return !entry.stopped && !entry.dead && entry.child.exitCode === null && entry.child.signalCode === null;
  }

  async function stop(entry) {
    if (entry.stopped) return;
    entry.stopped = true;
    try {
      await Promise.race([
        (async () => {
          try {
            await entry.connection.sendRequest("shutdown", undefined);
          } catch {}
          try {
            entry.connection.sendNotification("exit");
          } catch {}
        })(),
        new Promise((resolve) => setTimeout(resolve, stopGraceMs)),
      ]);
    } finally {
      entry.connection.dispose();
    }
    try {
      entry.connection.sendNotification("exit");
    } catch {}
    const exited = await Promise.race([
      (async () => {
        if (entry.child.exitCode !== null || entry.child.signalCode !== null) return true;
        await new Promise((resolve) => entry.child.once("exit", resolve));
        return true;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(false), stopGraceMs)),
    ]);
    if (!exited) entry.child.kill("SIGKILL");
  }

  async function start(sessionID, root, env) {
    const child = spawn(executable, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    const entry = {
      child, connection: null, env, documents: new Map(),
      stopped: false, dead: false, pid: child.pid, stderrText: "",
    };
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      entry.stderrText = (entry.stderrText + chunk).slice(-4096);
    });
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    entry.connection = connection;
    connection.onRequest("workspace/configuration", () => []);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onNotification("textDocument/publishDiagnostics", (params) => {
      entry.lastPublished.set(params.uri, params.diagnostics ?? []);
      const waiter = entry.openWaiters?.get(params.uri);
      if (waiter) {
        entry.openWaiters.delete(params.uri);
        waiter();
      }
    });
    entry.lastPublished = new Map();
    entry.openWaiters = new Map();
    child.on("error", () => {});
    child.on("exit", (code, signal) => {
      entry.dead = true;
      connection.dispose();
    });
    connection.listen();
    try {
      await new Promise((resolve, reject) => {
        child.on("error", reject);
        if (child.exitCode !== null || child.signalCode !== null) {
          reject(new Error(`pkl-lsp exited immediately: ${entry.stderrText.slice(-500)}`));
        } else {
          child.once("spawn", resolve);
        }
      });
      const capabilities = await connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        capabilities: { textDocument: { hover: { contentFormat: ["markdown", "plaintext"] }, publishDiagnostics: { relatedInformation: true } } },
      });
      connection.sendNotification("initialized", {});
      entry.hoverProvider = capabilities?.capabilities?.hoverProvider ?? capabilities?.hoverProvider;
      return entry;
    } catch (error) {
      entry.stopped = true;
      try { child.kill("SIGKILL"); } catch {}
      connection.dispose();
      throw error;
    }
  }

  // Exactly one lifecycle transition runs per identity at a time; every
  // spawned child is either stored or stopped before the transition ends.
  function chain(id, transition) {
    const previous = chains.get(id) ?? Promise.resolve();
    const next = previous.then(transition, transition);
    chains.set(id, next);
    next.then(
      () => { if (chains.get(id) === next) chains.delete(id); },
      () => { if (chains.get(id) === next) chains.delete(id); },
    );
    return next;
  }

  async function serverFor(sessionID, root, env, generation) {
    if (disposed) throw new Error("pkl servers are disposed");
    const id = key(sessionID, root);
    return chain(id, async () => {
      if (disposed) throw new Error("pkl servers are disposed");
      const current = servers.get(id);
      if (current && alive(current) && current.generation === generation) return current;
      if (current) {
        servers.delete(id);
        await stop(current).catch(() => {});
      }
      const entry = await start(sessionID, root, env);
      entry.generation = generation;
      if (disposed) {
        await stop(entry).catch(() => {});
        throw new Error("pkl servers are disposed");
      }
      servers.set(id, entry);
      return entry;
    });
  }

  async function open(entry, uri, file) {
    const known = entry.documents.get(uri);
    const text = await readFile(file, "utf8");
    if (known && known.text === text) return known;
    const version = (known?.version ?? 0) + 1;
    // The server applies document notifications asynchronously; a request
    // sent before it observes the open can fail. Wait for the publish
    // round-trip (bounded: some files produce no push).
    const observed = new Promise((resolve) => {
      entry.openWaiters.set(uri, resolve);
      setTimeout(resolve, 5_000).unref?.();
    });
    if (!known) {
      entry.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "pkl", version, text },
      });
    } else {
      entry.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    await observed;
    const record = { version, text };
    entry.documents.set(uri, record);
    return record;
  }

  // An explicit undefined token would be mistaken for a second request
  // parameter and corrupt the payload; only pass a token when present.
  function sendRequest(connection, method, params, token) {
    return token === undefined
      ? connection.sendRequest(method, params)
      : connection.sendRequest(method, params, token);
  }
  function tokenFor(signal) {
    if (!signal) return undefined;
    if (signal.aborted) throw abortError();
    return {
      get isCancellationRequested() { return signal.aborted; },
      onCancellationRequested: (callback) => {
        signal.addEventListener("abort", callback, { once: true });
        return { dispose: () => signal.removeEventListener("abort", callback) };
      },
    };
  }

  function withTimeout(promise, method, timeout) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`pkl-lsp request ${method} timed out`)), timeout);
      timer.unref?.();
    });
    return Promise.race([promiseFinally(promise, () => clearTimeout(timer)), deadline]);
  }

  function promiseFinally(promise, callback) {
    return promise.then(
      (value) => { callback(); return value; },
      (error) => { callback(); throw error; },
    );
  }

  async function withServer(sessionID, root, file, resolveEnvironment, signal) {
    const { root: realRoot, file: realFile, uri } = await canonicalUnder(root, file);
    await stat(realFile);
    const resolved = await resolveEnvironment({ sessionID, root: realRoot, signal });
    if (!resolved || typeof resolved.env !== "object" || typeof resolved.generation !== "string") {
      throw new Error("pkl environment resolution must return { env, generation }");
    }
    const env = {};
    for (const [name, value] of Object.entries(resolved.env)) {
      if (typeof value === "string") env[name] = value;
    }
    const entry = await serverFor(sessionID, realRoot, env, resolved.generation);
    await open(entry, uri, realFile);
    return { entry, uri };
  }

  return {
    async hover({ sessionID, root, file, line, character, resolveEnvironment, signal, timeout = timeoutMs }) {
      const token = tokenFor(signal);
      const { entry, uri } = await withServer(sessionID, root, file, resolveEnvironment, signal);
      if (!entry.hoverProvider) return { state: "unsupported" };
      const contents = await withTimeout(
        sendRequest(entry.connection, "textDocument/hover", {
          textDocument: { uri },
          position: { line: line - 1, character: character - 1 },
        }, token),
        "textDocument/hover",
        timeout ?? timeoutMs,
      );
      return { state: "ok", hover: contents ?? null, pid: entry.pid, generation: entry.generation };
    },

    async diagnostics({ sessionID, root, file, resolveEnvironment, signal, timeout = timeoutMs }) {
      const token = tokenFor(signal);
      const { entry, uri } = await withServer(sessionID, root, file, resolveEnvironment, signal);
      let result;
      try {
        result = await withTimeout(
          sendRequest(entry.connection, "textDocument/diagnostic", { textDocument: { uri } }, token),
          "textDocument/diagnostic",
          timeout ?? timeoutMs,
        );
      } catch (error) {
        if (error?.code === "cancelled") throw error;
        if (/timed out/.test(error.message)) return { state: "timeout" };
        if (/Method not found/i.test(String(error?.message))) return { state: "unsupported" };
        throw error;
      }
      if (!result || typeof result !== "object" || result.kind !== "full" || !Array.isArray(result.items)) {
        throw new Error(`pkl-lsp returned a malformed diagnostic report`);
      }
      return { state: "ok", diagnostics: result.items, pid: entry.pid, generation: entry.generation };
    },

    async status({ sessionID, root }) {
      const realRoot = await realpath(root);
      const entry = servers.get(key(sessionID, realRoot));
      if (!entry || !alive(entry)) return { running: false };
      return { running: true, pid: entry.pid, generation: entry.generation };
    },

    async dispose() {
      disposed = true;
      const ids = [...chains.values()];
      await Promise.all(ids.map((pending) => pending.catch(() => {})));
      const entries = [...servers.values()];
      servers.clear();
      await Promise.all(entries.map((entry) => stop(entry).catch(() => {})));
    },
  };
}
