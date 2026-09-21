// Registration and tool behavior for the Pkl plugin.
// Drives setupPkl with a stub tool domain and executes the registered tools
// against the real server; needs PKL_LSP_BIN like the lifecycle suite.
// Options travel through ctx.options exactly as the v2 loader provides them.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { id, setupPkl } from "../src/pkl.mjs";

const bin = process.env.PKL_LSP_BIN;
const gate = bin ? test : test.skip.bind(test, "pkl-lsp binary absent (set PKL_LSP_BIN)");

function stubToolDomain() {
  const added = new Map();
  return {
    added,
    transform: async (callback) => {
      callback({
        list: () => [...added.values()],
        get: (name) => added.get(name),
        namespace: () => {},
        add: (tool) => void added.set(tool.name, tool),
        update: () => {},
        remove: (name) => void added.delete(name),
      });
    },
    reload: async () => {},
    list: async () => [...added.values()],
  };
}

async function setup(dir) {
  const tool = stubToolDomain();
  const options = { executable: bin, args: ["--stdio"], roots: [dir] };
  const dispose = await setupPkl({ tool, options }, {});
  return { tool, dispose };
}

gate("registers hover, diagnostics and status tools", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-plugin-"));
  await writeFile(path.join(dir, "valid.pkl"), 'name = "world"\ngreeting = "hello"\n');
  await writeFile(path.join(dir, "bad.pkl"), 'name = "world"\nbroken (((\n');
  const { tool, dispose } = await setup(dir);
  const context = { sessionID: "s1", agent: "a", messageID: "m", id: "c" };
  try {
    assert.deepEqual([...tool.added.keys()].sort(), ["pkl_diagnostics", "pkl_hover", "pkl_status"]);

    const hover = await tool.added.get("pkl_hover").execute(
      { file: path.join(dir, "valid.pkl"), line: 2, character: 3 },
      context,
    );
    assert.match(hover.content, /greeting/);

    const diag = await tool.added.get("pkl_diagnostics").execute(
      { file: path.join(dir, "bad.pkl") },
      context,
    );
    const items = JSON.parse(diag.content).diagnostics;
    assert.equal(items.length, 1);
    assert.match(items[0].message, /unexpected token/);

    const status = await tool.added.get("pkl_status").execute(
      { file: path.join(dir, "valid.pkl") },
      context,
    );
    assert.equal(JSON.parse(status.content).running, true);
  } finally {
    await dispose();
  }
  const status = await tool.added.get("pkl_status").execute(
    { file: path.join(dir, "valid.pkl") },
    context,
  );
  assert.equal(JSON.parse(status.content).running, false);
});

gate("dotdot-prefixed names inside the root are allowed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-plugin-"));
  await writeFile(path.join(dir, "..notes.pkl"), 'name = "world"\n');
  const { tool, dispose } = await setup(dir);
  try {
    const hover = await tool.added.get("pkl_hover").execute(
      { file: path.join(dir, "..notes.pkl"), line: 1, character: 2 },
      { sessionID: "s1" },
    );
    assert.match(hover.content, /name/);
  } finally {
    await dispose();
  }
});

gate("rejects files outside the configured roots", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-plugin-"));
  const outside = await mkdtemp(path.join(tmpdir(), "pkl-outside-"));
  await writeFile(path.join(outside, "evil.pkl"), 'name = "x"\n');
  const { tool, dispose } = await setup(dir);
  try {
    await assert.rejects(
      tool.added.get("pkl_hover").execute(
        { file: path.join(outside, "evil.pkl"), line: 1, character: 1 },
        { sessionID: "s1" },
      ),
      /outside the configured roots/,
    );
  } finally {
    await dispose();
  }
});

gate("options override ctx options", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-plugin-"));
  const tool = stubToolDomain();
  const dispose = await setupPkl({ tool, options: { executable: "/nonexistent" } }, { executable: bin, args: ["--stdio"], roots: [dir] });
  try {
    assert.equal(tool.added.size, 3);
  } finally {
    await dispose();
  }
});

test("setup requires an executable", async () => {
  const tool = stubToolDomain();
  await assert.rejects(setupPkl({ tool, options: { roots: ["/tmp"] } }, {}), /absolute pkl-lsp executable/);
});

test("setup requires roots", async () => {
  const tool = stubToolDomain();
  await assert.rejects(setupPkl({ tool, options: { executable: bin ?? "/bin/false" } }, {}), /non-empty roots array/);
});

test("plugin identity", async () => {
  const { default: plugin } = await import("../src/pkl.mjs");
  assert.equal(plugin.id, id);
  assert.equal(typeof plugin.setup, "function");
});
