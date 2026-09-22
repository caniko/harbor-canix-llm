// Feasibility prototype, intentionally not the default package entrypoint.
// Covers only the registered native shell tool. See project-environment.mjs.
import { createProjectEnvironments, wrapProjectCommand } from "./project-environment.mjs";

export default {
  id: "canix.project-environment-prototype",
  async setup(ctx) {
    const { roots, direnv, nix, system, serverURL } = ctx.options;
    const backend = new URL(serverURL);
    if (backend.protocol !== "http:" || backend.hostname !== "127.0.0.1" || backend.username || backend.password) {
      throw new Error("Prototype requires an explicitly configured loopback backend");
    }
    const password = process.env.OPENCODE_PASSWORD;
    if (!password) throw new Error("Prototype requires the managed backend authentication environment");
    const environments = createProjectEnvironments({ roots, direnv, nix, system, baseline: process.env });
    const setEnvironment = async (sessionID, env, signal) => {
      const response = await fetch(new URL(`/api/session/${encodeURIComponent(sessionID)}/environment`, backend), {
        method: "PUT",
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ variables: env }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Cannot set session environment (${response.status})`);
    };
    await ctx.tool.transform((editor) => {
      for (const tool of editor.list()) {
        if (tool.name !== "shell") continue;
        editor.update(tool.id, (current) => {
          current.execute = wrapProjectCommand({ execute: current.execute, environments, setEnvironment, directory: ctx.location.directory });
        });
      }
    });
    // Explicit operator slash commands; no automatic direnv allow or config
    // edits. The prototype does not expose selection as an agent-side tool.
    await ctx.command.transform((editor) => {
      editor.add({ name: "project-env-select", execute: async ({ sessionID, prompt }) => {
        const { cwd = ctx.location.directory, shell } = JSON.parse(prompt.text);
        await environments.select({ sessionID, cwd, shell });
      } });
      editor.add({ name: "project-env-clear", execute: async ({ sessionID, prompt }) => {
        const { cwd = ctx.location.directory } = prompt.text ? JSON.parse(prompt.text) : {};
        await environments.clear({ sessionID, cwd });
      } });
    });
  },
};
