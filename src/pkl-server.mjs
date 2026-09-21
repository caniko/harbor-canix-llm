// Lifecycle manager for one pkl-lsp server per session and project root.
//
// Uses vscode-jsonrpc for framing and correlation. The caller supplies
// environment resolution; the resolved environment is used exactly — a
// resolution failure never falls back and never spawns a server.
//
// One serialized operation runs per session/root at a time, from environment
// resolution through the final response: a reselection can never retire a
// server out from under an in-flight request, and every spawned child is
// either stored or stopped before its operation ends.
//
// Document positions are 1-based lines and 1-based UTF-16 columns, converted
// to the 0-based LSP encoding at the boundary. Diagnostics are explicit
// results: an empty diagnostic set, a timeout, and an unsupported server are
// three different answers, never conflated.
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from "vscode-jsonrpc/node.js";

function escapes(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function canonicalUnder(root, file) {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
  if (escapes(realRoot, realFile)) throw new Error(`pkl file escapes the project root: ${file}`);
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

  async function exited(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => child.once("exit", resolve));
  }

  // Bounded wait that always clears its timer.
  async function deadline(ms, promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("pkl operation timed out")), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function stop(entry) {
    if (entry.stopped) return;
    entry.stopped = true;
    await deadline(stopGraceMs, (async () => {
      try {
        await entry.connection.sendRequest("shutdown", undefined);
      } catch {}
      try {
        entry.connection.sendNotification("exit");
      } catch {}
    })()).catch(() => {});
    entry.connection.dispose();
    await deadline(stopGraceMs, exited(entry.child)).catch(() => {});
    if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGKILL");
    await exited(entry.child);
  }

  async function start(root, env) {
    const child = spawn(executable, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    const entry = {
      child, connection: null, env, documents: new Map(),
      stopped: false, dead: false, pid: child.pid, stderrText: "",
    };
    const fail = (cause) => {
      entry.stopped = true;
      try { child.kill("SIGKILL"); } catch {}
      try { entry.connection?.dispose(); } catch {}
      throw cause;
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
    child.on("error", () => {});
    child.on("exit", () => {
      entry.dead = true;
      try { connection.dispose(); } catch {}
    });
    connection.listen();
    try {
      await new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          reject(new Error(`pkl-lsp exited immediately: ${entry.stderrText.slice(-500)}`));
        } else {
          child.once("error", reject);
          child.once("spawn", resolve);
        }
      });
      const capabilities = await withTimeout(
        connection.sendRequest("initialize", {
          processId: process.pid,
          rootUri: pathToFileURL(root).href,
          capabilities: { textDocument: { hover: { contentFormat: ["markdown", "plaintext"] }, publishDiagnostics: { relatedInformation: true } } },
        }),
        "initialize",
        timeoutMs,
      );
      connection.sendNotification("initialized", {});
      entry.hoverProvider = capabilities?.capabilities?.hoverProvider ?? capabilities?.hoverProvider;
      return entry;
    } catch (error) {
      fail(error);
    }
  }

  // Exactly one complete operation runs per identity at a time.
  function operate(id, operation) {
    const previous = chains.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    chains.set(id, next);
    const cleanup = () => { if (chains.get(id) === next) chains.delete(id); };
    next.then(cleanup, cleanup);
    return next;
  }

  async function serverFor(id, sessionID, root, env, generation) {
    if (disposed) throw new Error("pkl servers are disposed");
    const current = servers.get(id);
    if (current && alive(current) && current.generation === generation) return current;
    if (current) {
      servers.delete(id);
      await stop(current).catch(() => {});
    }
    const entry = await start(root, env);
    entry.generation = generation;
    if (disposed) {
      await stop(entry).catch(() => {});
      throw new Error("pkl servers are disposed");
    }
    servers.set(id, entry);
    return entry;
  }

  async function open(entry, uri, file) {
    const known = entry.documents.get(uri);
    const text = await readFile(file, "utf8");
    if (known && known.text === text) return known;
    const version = (known?.version ?? 0) + 1;
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

  function withTimeout(promise, method, timeout, signal) {
    let timer;
    let onAbort;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`pkl-lsp request ${method} timed out`)), timeout);
      timer.unref?.();
      if (signal) {
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    };
    return Promise.race([
      promise.then(
        (value) => { cleanup(); return value; },
        (error) => { cleanup(); throw error; },
      ),
      deadline.then(
        (value) => { cleanup(); return value; },
        (error) => { cleanup(); throw error; },
      ),
    ]);
  }

  async function operateOn(sessionID, root, file, resolveEnvironment, signal, action) {
    const { root: realRoot, file: realFile, uri } = await canonicalUnder(root, file);
    const id = key(sessionID, realRoot);
    return operate(id, async () => {
      if (signal?.aborted) throw abortError();
      const resolved = await resolveEnvironment({ sessionID, root: realRoot, signal });
      if (!resolved || typeof resolved.env !== "object" || typeof resolved.generation !== "string") {
        throw new Error("pkl environment resolution must return { env, generation }");
      }
      const env = {};
      for (const [name, value] of Object.entries(resolved.env)) {
        if (typeof value === "string") env[name] = value;
      }
      const attempt = async (retried) => {
        const entry = await serverFor(id, sessionID, realRoot, env, resolved.generation);
        await open(entry, uri, realFile);
        try {
          return await action(entry, uri);
        } catch (error) {
          // The server can die between the liveness check and the request
          // (external crash); replace it and retry exactly once.
          if (retried || alive(entry) || !/disposed|is not running|exited/i.test(String(error?.message))) throw error;
          servers.delete(id);
          return attempt(true);
        }
      };
      return attempt(false);
    });
  }

  return {
    async hover({ sessionID, root, file, line, character, resolveEnvironment, signal, timeout = timeoutMs }) {
      const token = tokenFor(signal);
      return operateOn(sessionID, root, file, resolveEnvironment, signal, async (entry, uri) => {
        if (!entry.hoverProvider) return { state: "unsupported" };
        const contents = await withTimeout(
          sendRequest(entry.connection, "textDocument/hover", {
            textDocument: { uri },
            position: { line: line - 1, character: character - 1 },
          }, token),
          "textDocument/hover",
          timeout ?? timeoutMs,
          signal,
        );
        return { state: "ok", hover: contents ?? null, pid: entry.pid, generation: entry.generation };
      });
    },

    async diagnostics({ sessionID, root, file, resolveEnvironment, signal, timeout = timeoutMs }) {
      const token = tokenFor(signal);
      return operateOn(sessionID, root, file, resolveEnvironment, signal, async (entry, uri) => {
        let result;
        try {
          result = await withTimeout(
            sendRequest(entry.connection, "textDocument/diagnostic", { textDocument: { uri } }, token),
            "textDocument/diagnostic",
            timeout ?? timeoutMs,
            signal,
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
      });
    },

    async status({ sessionID, root }) {
      const realRoot = await realpath(root);
      const entry = servers.get(key(sessionID, realRoot));
      if (!entry || !alive(entry)) return { running: false };
      return { running: true, pid: entry.pid, generation: entry.generation };
    },

    async dispose() {
      disposed = true;
      await Promise.all([...chains.values()].map((pending) => pending.catch(() => {})));
      const entries = [...servers.values()];
      servers.clear();
      await Promise.all(entries.map((entry) => stop(entry).catch(() => {})));
    },
  };
}
