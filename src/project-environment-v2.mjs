// Feasibility prototype, intentionally not the default package entrypoint.
// Requires the proposed session-aware shell hook. PTYs/formatters are not covered.
import { createProjectEnvironments, createEnvironmentBarrier } from "./project-environment.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

export async function waitForEnvironmentApproval({ request, sessionID, approval, signal }) {
  const endpoint = `/api/session/${encodeURIComponent(sessionID)}/form`;
  const id = `frm_${randomUUID()}`;
  let pending = true;
  try {
    await request("POST", endpoint, {
      id,
      title: "Project environment approval required",
      metadata: { project: approval.project, envrc: approval.envrc, revision: approval.revision },
      fields: [{
        key: "decision", type: "string", required: true, custom: false,
        title: `Review ${approval.envrc}`,
        description: `New execution is waiting. Reads and edits remain available; running commands are not cancelled. Review this file and approve it with direnv allow in the project, then retry. Revision: ${approval.revision}. Retrying alone does not grant trust.`,
        options: [
          { value: "retry", label: "Approved in direnv — retry" },
          { value: "deny", label: "Do not run" },
        ],
      }],
    }, signal);
    for (;;) {
      signal?.throwIfAborted();
      if (!await approval.isCurrent()) return "retry";
      const { state } = (await request("GET", `${endpoint}/${encodeURIComponent(id)}`, undefined, signal)).data;
      if (state.status === "answered") { pending = false; return state.answer.decision; }
      if (state.status === "cancelled") { pending = false; return "deny"; }
      await delay(300, undefined, { signal });
    }
  } finally {
    // Cancel an obsolete/caller-cancelled form independently of its signal.
    if (pending) await request("DELETE", `${endpoint}/${encodeURIComponent(id)}`).catch(() => {});
  }
}

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
    const environments = createProjectEnvironments({ roots, direnv, nix, system, baseline: process.env, direnvApproval: ctx.options.direnvApproval });
    const request = async (method, endpoint, body, signal) => {
      const response = await fetch(new URL(endpoint, backend), {
        method,
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Project environment API request failed (${response.status})`);
      return response.status === 204 ? undefined : response.json();
    };
    const barrier = createEnvironmentBarrier({
      environments,
      requestApproval: (input) => waitForEnvironmentApproval({ ...input, request }),
    });
    await ctx.shell.hook("create.before", async (invocation) => {
      // Requires the proposed native execution-context API. Old upstream
      // events fail closed; never invent a session or borrow another's env.
      if (!invocation.sessionID || !invocation.signal) {
        throw new Error("Project environments require the session-aware native shell hook API");
      }
      const snapshot = await barrier.resolve(invocation);
      invocation.env = { ...snapshot.env, TERM: invocation.env.TERM, OPENCODE_TERMINAL: "1" };
    });
    // Explicit operator slash commands use the same configured approval mode.
    // The prototype does not expose selection as an agent-side tool.
    await ctx.command.transform((editor) => {
      editor.add({ name: "project-env-select", execute: async ({ sessionID, prompt }) => {
        const { cwd = ctx.location.directory, shell } = JSON.parse(prompt.text);
        await barrier.select({ sessionID, cwd, shell });
      } });
      editor.add({ name: "project-env-clear", execute: async ({ sessionID, prompt }) => {
        const { cwd = ctx.location.directory } = prompt.text ? JSON.parse(prompt.text) : {};
        await barrier.clear({ sessionID, cwd });
      } });
    });
    const lifetime = new AbortController();
    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: lifetime.signal })) {
        if (event.type === "session.deleted") await barrier.release(event.data.sessionID);
        if (event.type === "session.moved") await barrier.reset(event.data.sessionID);
      }
    })().catch(async () => {
      if (!lifetime.signal.aborted) {
        console.error("Project environment lifecycle stream failed; preparation disabled until plugin reload");
      }
    }).finally(async () => {
      if (!lifetime.signal.aborted) await barrier.dispose();
    });
    return async () => {
      lifetime.abort();
      await barrier.dispose();
      await events;
    };
  },
};
