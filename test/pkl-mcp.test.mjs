import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import plugin from "../src/pkl-v2.mjs";

test("v2 entrypoint registers MCP, never unauthorised direct tools", async () => {
  const configs = new Map();
  await plugin.setup({
    options: { node: process.execPath, executable: "/bin/pkl-lsp", roots: ["/project"] },
    mcp: { transform: async (register) => register({ set: (name, config) => configs.set(name, config) }) },
  });
  assert.equal(configs.get("pkl").type, "local");
  assert.equal(configs.get("pkl").command[0], process.execPath);
});

test("real stdio MCP requires session metadata and serves Pkl", { skip: !process.env.PKL_LSP_BIN }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pkl-mcp-"));
  const file = path.join(root, "test.pkl");
  await writeFile(file, 'name = "world"\ngreeting = "hello"\n');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/pkl-mcp.mjs", import.meta.url)), JSON.stringify({
      executable: process.env.PKL_LSP_BIN, args: ["--stdio"], roots: [root],
    })],
  });
  const client = new Client({ name: "pkl-test", version: "1" });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 3);
  const request = { name: "pkl_hover", arguments: { file, line: 2, character: 3 } };
  await assert.rejects(client.callTool(request), /session metadata/);
  const result = await client.callTool({ ...request, _meta: { "ai.opencode/sessionID": "ses_mcp_test" } });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /greeting/);
});
