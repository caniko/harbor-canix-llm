// Integration tests for the Pkl server manager against the real server.
// Needs PKL_LSP_BIN pointing at a pkl-lsp executable; without it the
// real-server cases report as skipped instead of passing vacuously.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPklServers } from "../src/pkl-server.mjs";

const bin = process.env.PKL_LSP_BIN;
const gate = bin ? test : test.skip.bind(test, "pkl-lsp binary absent (set PKL_LSP_BIN)");

gate("hover and diagnostics through a real server", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-server-"));
  await writeFile(path.join(dir, "valid.pkl"), 'name = "world"\ngreeting = "hello"\n');
  await writeFile(path.join(dir, "bad.pkl"), 'name = "world"\nbroken (((\n');
  const servers = createPklServers({ executable: bin, args: ["--stdio"] });
  const resolveEnvironment = async () => ({ env: {}, generation: "g1" });
  try {
    const hover = await servers.hover({
      sessionID: "s1", root: dir, file: path.join(dir, "valid.pkl"),
      line: 2, character: 3, resolveEnvironment,
    });
    assert.equal(hover.state, "ok");
    // The server answers for the exact symbol under the cursor: name and range.
    assert.match(JSON.stringify(hover.hover), /greeting/);
    assert.equal(hover.generation, "g1");

    const diag = await servers.diagnostics({
      sessionID: "s1", root: dir, file: path.join(dir, "bad.pkl"), resolveEnvironment,
    });
    assert.equal(diag.state, "ok");
    assert.equal(diag.diagnostics.length, 1);
    assert.match(diag.diagnostics[0].message, /unexpected token/);

    const status = await servers.status({ sessionID: "s1", root: dir });
    assert.equal(status.running, true);
    assert.equal(status.pid, hover.pid);
  } finally {
    await servers.dispose();
  }
  const after = await servers.status({ sessionID: "s1", root: dir });
  assert.equal(after.running, false);
});

gate("generation change retires the old server without fallback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-server-"));
  await writeFile(path.join(dir, "valid.pkl"), 'name = "world"\n');
  const servers = createPklServers({ executable: bin, args: ["--stdio"] });
  const first = await servers.hover({
    sessionID: "s1", root: dir, file: path.join(dir, "valid.pkl"),
    line: 1, character: 1, resolveEnvironment: async () => ({ env: {}, generation: "g1" }),
  });
  const second = await servers.hover({
    sessionID: "s1", root: dir, file: path.join(dir, "valid.pkl"),
    line: 1, character: 1, resolveEnvironment: async () => ({ env: {}, generation: "g2" }),
  });
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.generation, "g2");
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(first.pid, 0);
    } catch {
      break;
    }
    if (i === 99) throw new Error("old server did not retire");
    await new Promise((r) => setTimeout(r, 100));
  }
  await servers.dispose();
});

gate("failed environment resolution never spawns a fallback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-server-"));
  await writeFile(path.join(dir, "valid.pkl"), 'name = "world"\n');
  const servers = createPklServers({ executable: bin, args: ["--stdio"] });
  try {
    await assert.rejects(
      servers.hover({
        sessionID: "s1", root: dir, file: path.join(dir, "valid.pkl"),
        line: 1, character: 1, resolveEnvironment: async () => { throw new Error("denied"); },
      }),
      /denied/,
    );
    assert.deepEqual(await servers.status({ sessionID: "s1", root: dir }), { running: false });
  } finally {
    await servers.dispose();
  }
});

gate("files outside the root are rejected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-server-"));
  const outside = await mkdtemp(path.join(tmpdir(), "pkl-outside-"));
  await writeFile(path.join(outside, "evil.pkl"), 'name = "x"\n');
  const servers = createPklServers({ executable: bin, args: ["--stdio"] });
  try {
    await assert.rejects(
      servers.hover({
        sessionID: "s1", root: dir, file: path.join(outside, "evil.pkl"),
        line: 1, character: 1, resolveEnvironment: async () => ({ env: {}, generation: "g1" }),
      }),
      /escapes the project root/,
    );
  } finally {
    await servers.dispose();
  }
});

gate("cancelled requests never spawn a server", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-server-"));
  await writeFile(path.join(dir, "valid.pkl"), 'name = "world"\n');
  const servers = createPklServers({ executable: bin, args: ["--stdio"] });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      servers.hover({
        sessionID: "s1", root: dir, file: path.join(dir, "valid.pkl"),
        line: 1, character: 1,
        resolveEnvironment: async () => ({ env: {}, generation: "g1" }),
        signal: controller.signal,
      }),
      /cancelled/,
    );
    assert.deepEqual(await servers.status({ sessionID: "s1", root: dir }), { running: false });
  } finally {
    await servers.dispose();
  }
});

gate("non-ASCII positions use UTF-16 columns", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-server-"));
  await writeFile(path.join(dir, "uni.pkl"), 'grüße = "hallo"\n');
  const servers = createPklServers({ executable: bin, args: ["--stdio"] });
  try {
    const hover = await servers.hover({
      sessionID: "s1", root: dir, file: path.join(dir, "uni.pkl"),
      line: 1, character: 2, resolveEnvironment: async () => ({ env: {}, generation: "g1" }),
    });
    assert.equal(hover.state, "ok");
  } finally {
    await servers.dispose();
  }
});
