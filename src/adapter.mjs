import { createEnvironments } from "./environments.mjs";
import { realpath } from "node:fs/promises";
import path from "node:path";

// Hook implementation stays independent of SDK schemas so it can be tested with Node's stdlib.
export function createAdapter(registry, prepareEnvironment) {
  const environments = createEnvironments(registry, prepareEnvironment);
  const compatible = new Set();
  return {
    async execute(args, context) {
      if (!context.sessionID) throw new Error("Session identity is required");
      if (Object.keys(args).some((key) => !["action", "project", "shell"].includes(key))) {
        throw new Error("Unexpected dev-shell arguments; commands and overrides are not accepted");
      }
      if (args.action === "list") return JSON.stringify(environments.list());
      if (!args.project) throw new Error("A registered project is required");
      if (args.action === "status") return JSON.stringify({
        compatible: compatible.has(context.sessionID), selected: environments.status(context.sessionID, args.project),
      });
      if (args.action === "clear") {
        environments.clear(context.sessionID, args.project);
        return "Selection cleared; subsequent commands use the harness baseline/direnv policy.";
      }
      if (args.action !== "select" || !args.shell) throw new Error("Expected select with a named shell");
      if (!compatible.has(context.sessionID)) throw new Error("Environment replacement is not verified. Run an ordinary Bash tool call on the patched OpenCode runtime first.");
      const project = environments.list().find((entry) => entry.name === args.project);
      if (!project) throw new Error("Project is not registered");
      const root = await realpath(project.root);
      const worktree = await realpath(context.worktree || context.directory);
      if (root !== worktree && !root.startsWith(worktree + path.sep)) {
        await context.ask({
          permission: "external_directory", patterns: [root + "/*"], always: [root + "/*"],
          metadata: { directory: root },
        });
      }
      const selected = await environments.select({
        session: context.sessionID, project: args.project, shell: args.shell,
        cwd: root, signal: context.abort,
        authorize: (identity) => context.ask({
          permission: "harbor_dev_shell_prepare", patterns: [identity], always: [identity],
          metadata: { identity, operation: "Realize dev shell and execute its trusted shellHook; no agent command" },
        }),
      });
      return JSON.stringify(selected);
    },
    async shellEnvironment(input, output) {
      // PTYs and other sessionless entry points never inherit a selection.
      if (!input.sessionID) return;
      if (input.harborCanixLlm !== 1) {
        throw new Error("OpenCode lacks the harbor-canix-llm replacement contract; refusing environment injection");
      }
      compatible.add(input.sessionID);
      const env = await environments.environment(input.sessionID, input.cwd);
      if (!env) return;
      output.env = env;
      output.harborCanixLlmReplace = true;
    },
    release: (session) => {
      compatible.delete(session);
      environments.release(session);
    },
  };
}
