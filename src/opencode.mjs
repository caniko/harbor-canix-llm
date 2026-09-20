import { readFile, realpath } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";
import { createAdapter } from "./adapter.mjs";
import { prepare } from "./environments.mjs";

export const HarborCanixLlm = async (_context, options) => {
  if (process.platform !== "linux") throw new Error("harbor-canix-llm currently supports Linux only");
  const registryPath = await realpath(options.registry);
  if (!registryPath.startsWith("/nix/store/")) throw new Error("Registry must be an operator-installed Nix store file");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const baseline = { ...process.env };
  const adapter = createAdapter(registry, (input) => prepare({
    ...input, baseline, nix: options.nix, node: options.node, capture: options.capture,
  }));
  return {
    tool: {
      harbor_devshell: tool({
        description: "List/select/status/clear an approved immutable project dev shell. Selection separately requests permission to realize it and execute its trusted hook. Only one selection may cover a working directory: selecting a project whose root contains (or sits inside) another selected project fails closed, so clear the overlapping selection first. Never executes an agent command. Bash commands retain normal permission checks. Run one ordinary Bash call first to verify the replacement hook.",
        args: {
          action: tool.schema.enum(["list", "select", "status", "clear"]),
          project: tool.schema.string().optional(),
          shell: tool.schema.string().optional(),
        },
        execute: adapter.execute,
      }),
    },
    "shell.env": adapter.shellEnvironment,
    "lsp.env": adapter.lspEnvironment,
    event: async ({ event }) => {
      if (event.type === "session.deleted") adapter.release(event.properties.info.id);
    },
  };
};
