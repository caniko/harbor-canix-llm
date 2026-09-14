// Verify the narrow patch against a real checkout without modifying that checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) throw new Error("Usage: node test/check-opencode.mjs /path/to/opencode");
const root = await mkdtemp(path.join(tmpdir(), "harbor-opencode-contract-"));
try {
  const files = ["packages/opencode/src/tool/shell.ts", "packages/plugin/src/index.ts", "packages/core/src/tool/bash.ts"];
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await copyFile(path.join(source, file), path.join(root, file));
  }
  const original = await readFile(path.join(root, files[0]), "utf8");
  execFileSync("git", ["apply", fileURLToPath(new URL("../patches/opencode-shell-environment.patch", import.meta.url))], { cwd: root });
  const patched = await readFile(path.join(root, files[0]), "utf8");
  const permission = (text) => text.match(/const ask = [\s\S]*?(?=function toolOomCommand)/)?.[0];
  assert.ok(permission(original), "cannot identify the permission boundary");
  assert.equal(permission(patched), permission(original), "permission implementation changed");
  assert.ok(patched.indexOf("yield* ask(ctx, scan, params)") < patched.indexOf("env: yield* shellEnv(ctx, cwd)"));
  assert.ok(patched.indexOf("yield* ask(ctx, scan, params)") >= 0);
  assert.equal((patched.match(/extendEnv: false/g) || []).length, 2, "child processes must not merge the parent environment back in");
  assert.ok(patched.includes("OPENCODE_TOOL_OOM_SCORE_ADJ: process.env.OPENCODE_TOOL_OOM_SCORE_ADJ"));
  assert.ok(patched.indexOf("if (extra.harborCanixLlmReplace)") < patched.indexOf("...process.env", patched.indexOf("const shellEnv")));
  assert.ok(!original.includes("Direnv.environment"), "this patch targets the shipped baseline, not an uncommitted direnv variant");
  const core = await readFile(path.join(root, files[2]), "utf8");
  const guard = core.indexOf('process.env.HARBOR_CANIX_LLM_REQUIRE_LEGACY === "1"');
  assert.ok(guard > core.indexOf("yield* permission.assert({", core.indexOf("const source =")));
  assert.ok(guard < core.indexOf("ChildProcess.make(input.command"));
  console.log("OpenCode patch, permission ordering, full child environment, and OOM policy contract passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
