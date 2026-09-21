// Pkl language assistance as v2 custom tools.
//
// No OpenCode SDK import: v2 treats the default export as plugin data and
// the setup function receives the context, including configured options.
// Tool inputs carry only the file and position; the allowed project roots
// come from trusted plugin configuration, never from the model. File access
// is project-local only: every path is canonicalized against the matched
// root and escapes are rejected before any read. Environment resolution
// defaults to the documented baseline snapshot; Harbor selection wiring
// arrives separately and must never silently fall back when a selection
// exists but fails to resolve.
//
// Permission tracing for custom file-reading tools is still open: until the
// v2 FileAccess boundary for promise tools is verified, keep tools to
// project-local files and surface the active root in every response.
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createPklServers } from "./pkl-server.mjs";

export const id = "canix.pkl";

function baselineEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[name] = value;
  }
  return { env, generation: "baseline" };
}

async function matchRoot(roots, file) {
  const realFile = await realpath(file).catch(() => path.resolve(file));
  let best = null;
  for (const root of roots) {
    const realRoot = await realpath(root);
    const relative = path.relative(realRoot, realFile);
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      if (!best || realRoot.length > best.length) best = realRoot;
    }
  }
  if (!best) throw new Error(`pkl file is outside the configured roots: ${file}`);
  return { root: best, file: realFile };
}

const fileSchema = {
  type: "object",
  properties: {
    file: { type: "string", description: "Pkl file to inspect." },
  },
  required: ["file"],
};

const positionSchema = {
  type: "object",
  properties: {
    file: { type: "string" },
    line: { type: "integer", minimum: 1, description: "1-based line." },
    character: { type: "integer", minimum: 1, description: "1-based UTF-16 column." },
  },
  required: ["file", "line", "character"],
};

export async function setupPkl(ctx, overrides = {}) {
  const options = { ...ctx.options, ...overrides };
  const { executable, args = [], timeoutMs, resolveEnvironment, roots = [] } = options;
  if (!executable) throw new Error("canix.pkl requires an absolute pkl-lsp executable path");
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((root) => typeof root !== "string")) {
    throw new Error("canix.pkl requires a non-empty roots array of project directories");
  }
  const servers = createPklServers({ executable, args, timeoutMs });
  const resolve = resolveEnvironment ?? (async () => baselineEnvironment());
  const withSignal = (context) => (context?.signal ? { signal: context.signal } : {});

  await ctx.tool.transform((tools) => {
    tools.add({
      name: "pkl_hover",
      description: "Hover type and documentation for the symbol at a Pkl position.",
      input: positionSchema,
      execute: async (input, context) => {
        const { root, file } = await matchRoot(roots, input.file);
        const result = await servers.hover({
          sessionID: context.sessionID,
          root,
          file,
          line: input.line,
          character: input.character,
          resolveEnvironment: resolve,
          ...withSignal(context),
        });
        if (result.state !== "ok") return { content: `pkl hover ${result.state}` };
        return { content: JSON.stringify({ root, hover: result.hover ?? null }) };
      },
    });
    tools.add({
      name: "pkl_diagnostics",
      description: "Diagnostics for a saved Pkl file. A timeout or unsupported server is reported, never read as valid.",
      input: fileSchema,
      execute: async (input, context) => {
        const { root, file } = await matchRoot(roots, input.file);
        const result = await servers.diagnostics({
          sessionID: context.sessionID,
          root,
          file,
          resolveEnvironment: resolve,
          ...withSignal(context),
        });
        if (result.state !== "ok") return { content: `pkl diagnostics ${result.state}` };
        return { content: JSON.stringify({ root, diagnostics: result.diagnostics }) };
      },
    });
    tools.add({
      name: "pkl_status",
      description: "Whether a Pkl server is running for this session and root.",
      input: fileSchema,
      execute: async (input, context) => {
        const { root } = await matchRoot(roots, input.file);
        return {
          content: JSON.stringify({ root, ...(await servers.status({ sessionID: context.sessionID, root })) }),
        };
      },
    });
  });

  return async () => {
    await servers.dispose();
  };
}

export default { id, setup: (ctx) => setupPkl(ctx) };
