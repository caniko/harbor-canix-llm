// Registration and tool behavior for the Pkl plugin.
// Drives setupPkl with a stub tool domain and executes the registered tools
// against the real server; needs PKL_LSP_BIN like the lifecycle suite.
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

gate("registers hover, diagnostics and status tools", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-plugin-"));
  await writeFile(path.join(dir, "valid.pkl"), 'name = "world"\ngreeting = "hello"\n');
  await writeFile(path.join(dir, "bad.pkl"), 'name = "world"\nbroken (((\n');
  const tool = stubToolDomain();
  const dispose = await setupPkl({ tool }, { executable: bin, args: ["--stdio"] });
  const context = { sessionID: "s1", agent: "a", messageID: "m", id: "c" };
  try {
    assert.deepEqual([...tool.added.keys()].sort(), ["pkl_diagnostics", "pkl_hover", "pkl_status"]);

    const hover = await tool.added.get("pkl_hover").execute(
      { root: dir, file: path.join(dir, "valid.pkl"), line: 2, character: 3 },
      context,
    );
    assert.match(hover.content, /greeting/);

    const diag = await tool.added.get("pkl_diagnostics").execute(
      { root: dir, file: path.join(dir, "bad.pkl") },
      context,
    );
    const items = JSON.parse(diag.content);
    assert.equal(items.length, 1);
    assert.match(items[0].message, /unexpected token/);

    const status = await tool.added.get("pkl_status").execute(
      { root: dir, file: path.join(dir, "valid.pkl") },
      context,
    );
    assert.equal(JSON.parse(status.content).running, true);
  } finally {
    await dispose();
  }
  const status = await tool.added.get("pkl_status").execute(
    { root: dir, file: path.join(dir, "valid.pkl") },
    context,
  );
  assert.equal(JSON.parse(status.content).running, false);
});

gate("rejects files outside the root", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pkl-plugin-"));
  const outside = await mkdtemp(path.join(tmpdir(), "pkl-outside-"));
  await writeFile(path.join(outside, "evil.pkl"), 'name = "x"\n');
  const tool = stubToolDomain();
  const dispose = await setupPkl({ tool }, { executable: bin, args: ["--stdio"] });
  try {
    await assert.rejects(
      tool.added.get("pkl_hover").execute(
        { root: dir, file: path.join(outside, "evil.pkl"), line: 1, character: 1 },
        { sessionID: "s1" },
      ),
      /escapes the project root/,
    );
  } finally {
    await dispose();
  }
});

test("setup requires an executable", async () => {
  const tool = stubToolDomain();
  await assert.rejects(setupPkl({ tool }, {}), /absolute pkl-lsp executable/);
});

test("plugin identity", async () => {
  const { default: plugin } = await import("../src/pkl.mjs");
  assert.equal(plugin.id, id);
  assert.equal(typeof plugin.setup, "function");
});
