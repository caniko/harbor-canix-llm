// Pkl language assistance as v2 custom tools.
//
// No OpenCode SDK import: v2 treats the default export as plugin data and
// the setup function receives the context. Tool inputs are plain JSON
// schemas. File access is project-local only: every path is canonicalized
// against the supplied root and escapes are rejected before any read.
// Environment resolution defaults to the documented baseline snapshot;
// Harbor selection wiring arrives separately and must never silently fall
// back when a selection exists but fails to resolve.
import { createPklServers } from "./pkl-server.mjs";

export const id = "canix.pkl";

function baselineEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[name] = value;
  }
  return { env, generation: "baseline" };
}

const rootSchema = {
  type: "object",
  properties: {
    root: { type: "string", description: "Project root; files cannot escape it." },
    file: { type: "string", description: "Pkl file to inspect." },
  },
  required: ["root", "file"],
};

const positionSchema = {
  type: "object",
  properties: {
    root: { type: "string" },
    file: { type: "string" },
    line: { type: "integer", minimum: 1, description: "1-based line." },
    character: { type: "integer", minimum: 1, description: "1-based UTF-16 column." },
  },
  required: ["root", "file", "line", "character"],
};

export async function setupPkl(ctx, options = {}) {
  const { executable, args = [], timeoutMs, resolveEnvironment } = options;
  if (!executable) throw new Error("canix.pkl requires an absolute pkl-lsp executable path");
  const servers = createPklServers({ executable, args, timeoutMs });
  const resolve = resolveEnvironment ?? (async () => baselineEnvironment());
  const withSignal = (context) => (context?.signal ? { signal: context.signal } : {});

  await ctx.tool.transform((tools) => {
    tools.add({
      name: "pkl_hover",
      description: "Hover type and documentation for the symbol at a Pkl position.",
      input: positionSchema,
      execute: async (input, context) => {
        const result = await servers.hover({
          sessionID: context.sessionID,
          root: input.root,
          file: input.file,
          line: input.line,
          character: input.character,
          resolveEnvironment: resolve,
          ...withSignal(context),
        });
        if (result.state !== "ok") return { content: `pkl hover ${result.state}` };
        return { content: JSON.stringify(result.hover ?? null) };
      },
    });
    tools.add({
      name: "pkl_diagnostics",
      description: "Diagnostics for a saved Pkl file. A timeout or unsupported server is reported, never read as valid.",
      input: rootSchema,
      execute: async (input, context) => {
        const result = await servers.diagnostics({
          sessionID: context.sessionID,
          root: input.root,
          file: input.file,
          resolveEnvironment: resolve,
          ...withSignal(context),
        });
        if (result.state !== "ok") return { content: `pkl diagnostics ${result.state}` };
        return { content: JSON.stringify(result.diagnostics) };
      },
    });
    tools.add({
      name: "pkl_status",
      description: "Whether a Pkl server is running for this session and root.",
      input: rootSchema,
      execute: async (input, context) => ({
        content: JSON.stringify(await servers.status({ sessionID: context.sessionID, root: input.root })),
      }),
    });
  });

  return async () => {
    await servers.dispose();
  };
}

export default { id, setup: setupPkl };
