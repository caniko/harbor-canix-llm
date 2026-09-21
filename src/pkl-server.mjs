// Lifecycle manager for one pkl-lsp server per session and project root.
//
// Uses only node builtins so the managed backend and every test runner can
// load it. The caller supplies environment resolution; a resolution failure
// never falls back to another environment and never spawns a server.
//
// Document positions are 1-based lines and 1-based UTF-16 columns, converted
// to the 0-based LSP encoding at the boundary. Diagnostics are explicit
// results: an empty diagnostic set, a timeout, and an unsupported server are
// three different answers, never conflated.
import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(message) {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

class Transport {
  constructor(child, { onRequest, onStderr } = {}) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = new Uint8Array(0);
    this.closed = false;
    this.onRequest = onRequest;
    this.stderrText = "";
    child.stdout.on("data", (chunk) => this.ingest(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      this.stderrText = (this.stderrText + chunk).slice(-4096);
      onStderr?.(chunk);
    });
    child.on("exit", () => {
      this.closed = true;
      for (const entry of this.pending.values()) entry.reject(new Error("pkl-lsp exited"));
      this.pending.clear();
    });
  }

  ingest(chunk) {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
    for (;;) {
      const text = decoder.decode(this.buffer);
      const at = text.indexOf("\r\n\r\n");
      if (at === -1) return;
      const match = /Content-Length: (\d+)/i.exec(text.slice(0, at));
      if (!match) throw new Error("pkl-lsp sent a malformed header");
      const length = Number(match[1]);
      const headerBytes = encoder.encode(text.slice(0, at + 4)).length;
      if (this.buffer.length < headerBytes + length) return;
      const body = JSON.parse(decoder.decode(this.buffer.slice(headerBytes, headerBytes + length)));
      this.buffer = this.buffer.slice(headerBytes + length);
      this.dispatch(body);
    }
  }

  dispatch(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      if (message.error !== undefined) entry.reject(new Error(`pkl-lsp error: ${JSON.stringify(message.error)}`));
      else entry.resolve(message.result);
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      Promise.resolve(this.onRequest?.(message.method, message.params))
        .then((result) => this.notify({ jsonrpc: "2.0", id: message.id, result: result ?? null }))
        .catch((error) => this.notify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error?.message ?? error) } }));
      return;
    }
    this.notification?.(message.method, message.params);
  }

  notify(message) {
    if (!this.closed) this.child.stdin.write(frame(message));
  }

  request(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error("pkl-lsp is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: undefined };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`pkl-lsp request ${method} timed out`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.notify({ jsonrpc: "2.0", id, method, params });
    });
  }
}

async function canonicalUnder(root, file) {
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file).catch(() => path.resolve(file))]);
  const relative = path.relative(realRoot, realFile);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`pkl file escapes the project root: ${file}`);
  }
  return { root: realRoot, file: realFile, uri: `file://${realFile}` };
}

export function createPklServers({ executable, args = [], timeoutMs = 30_000, stopGraceMs = 5_000 } = {}) {
  if (!executable) throw new Error("pkl server executable is required");
  const servers = new Map();
  const starting = new Map();
  let disposed = false;

  function key(sessionID, root) {
    if (!sessionID) throw new Error("pkl server identity requires a session");
    return `${sessionID}::${root}`;
  }

  async function exited(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => child.once("exit", resolve));
  }

  async function stop(entry) {
    const { child, transport } = entry;
    if (entry.stopped) return;
    entry.stopped = true;
    try {
      await transport.request("shutdown", undefined, stopGraceMs);
      transport.notify({ jsonrpc: "2.0", method: "exit" });
    } catch {}
    const exitedOk = await Promise.race([
      exited(child).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), stopGraceMs)),
    ]);
    if (!exitedOk) child.kill("SIGKILL");
    await exited(child);
  }

  async function start(sessionID, root, env) {
    const child = spawn(executable, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    const entry = { child, transport: null, env, documents: new Map(), stopped: false, pid: child.pid };
    entry.transport = new Transport(child, {
      onRequest: async (method) => {
        if (method === "workspace/configuration") return [];
        if (method === "window/workDoneProgress/create") return null;
        throw new Error(`unsupported server request: ${method}`);
      },
    });
    entry.transport.notification = (method, params) => entry.events?.(method, params);
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("spawn", resolve);
      setTimeout(() => reject(new Error("pkl-lsp did not spawn")), 10_000).unref?.();
    });
    const capabilities = await entry.transport.request("initialize", {
      processId: process.pid,
      rootUri: `file://${root}`,
      capabilities: { textDocument: { hover: { contentFormat: ["markdown", "plaintext"] }, publishDiagnostics: { relatedInformation: true } } },
    }, timeoutMs);
    entry.transport.notify({ jsonrpc: "2.0", method: "initialized", params: {} });
    entry.hoverProvider = capabilities?.capabilities?.hoverProvider ?? capabilities?.hoverProvider;
    return entry;
  }

  async function serverFor(sessionID, root, env, generation) {
    if (disposed) throw new Error("pkl servers are disposed");
    const id = key(sessionID, root);
    const current = servers.get(id);
    if (current && !current.stopped && current.generation === generation) return current;
    let inflight = starting.get(id);
    if (!inflight || inflight.generation !== generation) {
      inflight = (async () => {
        if (current && !current.stopped) {
          servers.delete(id);
          await stop(current).catch(() => {});
        }
        const entry = await start(sessionID, root, env);
        entry.generation = generation;
        if (servers.get(id) === undefined) servers.set(id, entry);
        return entry;
      })();
      inflight.generation = generation;
      starting.set(id, inflight);
      inflight.then(
        () => { if (starting.get(id) === inflight) starting.delete(id); },
        () => { if (starting.get(id) === inflight) starting.delete(id); },
      );
    }
    const entry = await inflight;
    if (entry.generation !== generation || entry.stopped) {
      return serverFor(sessionID, root, env, generation);
    }
    return entry;
  }

  async function open(entry, uri, file) {
    const known = entry.documents.get(uri);
    const text = await readFile(file, "utf8");
    if (known && known.text === text) return known;
    const version = (known?.version ?? 0) + 1;
    if (!known) {
      entry.transport.notify({
        jsonrpc: "2.0", method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "pkl", version, text } },
      });
    } else {
      entry.transport.notify({
        jsonrpc: "2.0", method: "textDocument/didChange",
        params: { textDocument: { uri, version }, contentChanges: [{ text }] },
      });
    }
    const record = { version, text };
    entry.documents.set(uri, record);
    return record;
  }

  async function withServer(sessionID, root, file, resolveEnvironment, signal) {
    const { root: realRoot, file: realFile, uri } = await canonicalUnder(root, file);
    await stat(realFile);
    const resolved = await resolveEnvironment({ sessionID, root: realRoot, signal });
    if (!resolved || typeof resolved.env !== "object" || typeof resolved.generation !== "string") {
      throw new Error("pkl environment resolution must return { env, generation }");
    }
    const extra = {};
    const env = {};
    for (const [name, value] of Object.entries({ ...process.env, ...resolved.env })) {
      if (typeof value === "string") env[name] = value;
    }
    const entry = await serverFor(sessionID, realRoot, env, resolved.generation);
    await open(entry, uri, realFile);
    return { entry, uri };
  }

  return {
    async hover({ sessionID, root, file, line, character, resolveEnvironment, signal, timeout = timeoutMs }) {
      const { entry, uri } = await withServer(sessionID, root, file, resolveEnvironment, signal);
      if (!entry.hoverProvider) return { state: "unsupported" };
      const contents = await entry.transport.request("textDocument/hover", {
        textDocument: { uri },
        position: { line: line - 1, character: character - 1 },
      }, timeout ?? timeoutMs);
      return { state: "ok", hover: contents ?? null, pid: entry.pid, generation: entry.generation };
    },

    async diagnostics({ sessionID, root, file, resolveEnvironment, signal, timeout = timeoutMs }) {
      const { entry, uri } = await withServer(sessionID, root, file, resolveEnvironment, signal);
      const diagnostics = await entry.transport
        .request("textDocument/diagnostic", { textDocument: { uri } }, timeout ?? timeoutMs)
        .catch((error) => {
          if (/timed out/.test(error.message)) return { state: "timeout" };
          if (/Method not found/i.test(error.message)) return { state: "unsupported" };
          throw error;
        });
      if (diagnostics && typeof diagnostics === "object" && "state" in diagnostics) return diagnostics;
      const items = diagnostics?.kind === "full" ? diagnostics.items : (diagnostics?.items ?? []);
      return { state: "ok", diagnostics: items, pid: entry.pid, generation: entry.generation };
    },

    async status({ sessionID, root }) {
      const realRoot = await realpath(root);
      const entry = servers.get(key(sessionID, realRoot));
      if (!entry || entry.stopped) return { running: false };
      return { running: true, pid: entry.pid, generation: entry.generation };
    },

    async dispose() {
      disposed = true;
      const entries = [...servers.values()];
      servers.clear();
      await Promise.all(entries.map((entry) => stop(entry).catch(() => {})));
    },
  };
}
