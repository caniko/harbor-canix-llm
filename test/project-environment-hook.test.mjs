import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/project-environment-v2.mjs";

test("native integration registers a shell hook and rejects unsupported execution contexts", async (t) => {
  const before = process.env.OPENCODE_PASSWORD;
  process.env.OPENCODE_PASSWORD = "fixture-only";
  t.after(() => {
    if (before === undefined) delete process.env.OPENCODE_PASSWORD;
    else process.env.OPENCODE_PASSWORD = before;
  });
  let prepare;
  const deleted = Promise.withResolvers();
  const dispose = await plugin.setup({
    options: { roots: ["/fixture"], direnv: "/fixture/direnv", nix: "/fixture/nix", system: "x86_64-linux", serverURL: "http://127.0.0.1:1" },
    location: { directory: "/fixture" },
    shell: { hook: async (name, callback) => { assert.equal(name, "create.before"); prepare = callback; } },
    command: { transform: async () => {} },
    event: { async *subscribe({ signal }) {
      yield { type: "session.deleted", data: { sessionID: "ses_deleted" } };
      deleted.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    } },
    // No tool-transform domain: the plugin must not wrap the native tool.
  });
  t.after(dispose);
  await deleted.promise;
  await assert.rejects(prepare({ sessionID: "ses_deleted", cwd: "/fixture", env: {}, signal: new AbortController().signal }), /unavailable/);
  await assert.rejects(prepare({ cwd: "/fixture", env: {} }), /session-aware native shell hook/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepare({ sessionID: "ses_test", cwd: "/fixture", env: {}, signal: controller.signal }), { name: "AbortError" });
  await dispose();
  await assert.rejects(prepare({ sessionID: "ses_new", cwd: "/fixture", env: {}, signal: new AbortController().signal }), /unavailable/);
});
