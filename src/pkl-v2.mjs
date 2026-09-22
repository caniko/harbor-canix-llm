// Stock v2 owns MCP execution authorization; direct custom tools do not.
import path from "node:path";
import { fileURLToPath } from "node:url";

export default {
  id: "canix.pkl",
  async setup(ctx) {
    const { node, executable, roots, args = ["--stdio"], timeoutMs = 30_000 } = ctx.options;
    if (![node, executable].every((value) => typeof value === "string" && path.isAbsolute(value))) {
      throw new Error("Pkl requires absolute Node and pkl-lsp executable paths");
    }
    if (!Array.isArray(roots) || !roots.length || roots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
      throw new Error("Pkl requires configured absolute project roots");
    }
    await ctx.mcp.transform((editor) => editor.set("pkl", {
      type: "local",
      command: [node, fileURLToPath(new URL("./pkl-mcp.mjs", import.meta.url)), JSON.stringify({ executable, roots, args, timeoutMs })],
      timeout: { execution: timeoutMs + 10_000 },
    }));
  },
};
