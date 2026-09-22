import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPklServers } from "../src/pkl-server.mjs";

async function fixture(t, initialize) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pkl-cancellation-"));
  const server = path.join(root, "server.mjs");
  const file = path.join(root, "file.pkl");
  const received = path.join(root, "received");
  await writeFile(file, 'name = "hello"\n');
  await writeFile(server, `
import { writeFileSync } from "node:fs";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from ${JSON.stringify(import.meta.resolve("vscode-jsonrpc/node.js"))};
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
const stalled = () => {
  writeFileSync(${JSON.stringify(received)}, String(process.pid));
  return new Promise(() => {});
};
connection.onRequest("initialize", ${initialize ? "stalled" : '() => ({capabilities: {hoverProvider: true}})'});
connection.onRequest("textDocument/hover", stalled);
connection.listen();
`);
  const servers = createPklServers({ executable: process.execPath, args: [server], timeoutMs: 10_000 });
  t.after(async () => { await servers.dispose(); await rm(root, { recursive: true, force: true }); });
  const input = { sessionID: "s", root, file, line: 1, character: 1,
    resolveEnvironment: async () => ({ env: {}, generation: "test" }) };
  async function acknowledged() {
    for (let i = 0; i < 200; i++) {
      try { return Number(await readFile(received, "utf8")); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("server did not acknowledge receipt");
  }
  return { servers, input, acknowledged };
}

for (const initialize of [true, false]) {
  test(`abort after server receives ${initialize ? "initialize" : "hover"} reaps child`, { timeout: 5000 }, async (t) => {
    const { servers, input, acknowledged } = await fixture(t, initialize);
    const controller = new AbortController();
    const rejected = assert.rejects(servers.hover({ ...input, signal: controller.signal }), /cancelled/);
    const pid = await acknowledged();
    controller.abort();
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.deepEqual(await servers.status(input), { running: false });
  });
}

test("dispose interrupts initialization and awaits child exit", { timeout: 5000 }, async (t) => {
  const { servers, input, acknowledged } = await fixture(t, true);
  const rejected = assert.rejects(servers.hover(input), /cancelled|disposed/);
  const pid = await acknowledged();
  await servers.dispose();
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("abort interrupts an uncooperative environment resolver before spawn", { timeout: 5000 }, async (t) => {
  const { servers, input } = await fixture(t, true);
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const rejected = assert.rejects(servers.hover({
    ...input, signal: controller.signal,
    resolveEnvironment: () => { entered(); return new Promise(() => {}); },
  }), /cancelled/);
  await started;
  controller.abort();
  await rejected;
  assert.deepEqual(await servers.status(input), { running: false });
});
