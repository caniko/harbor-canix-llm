# harbor-canix-llm

Canix-specific harness orchestration, starting with session/project-scoped
dev-shell switching in OpenCode. Language Harbors still own compilers and
their dev shells. `harbor-meta` owns generic shell composition. This project
owns personal harness policy and adapters; Canix supplies the approved projects.

## Contract

- No agent command is accepted or executed by the environment backend.
- An operator-installed registry names canonical project directories and exact
  dev-shell derivations. No `.envrc` evaluation or automatic approval occurs.
- Selection requests `harbor_dev_shell_prepare` permission for the exact
  `project:shell:/nix/store/...drv` identity, including cache hits. Preparation
  can realize dependencies and executes the trusted shell hook. It is not a
  read-only operation and does not activate NixOS or Home Manager.
- Bash commands are unchanged and still pass through the harness permission
  check before their child environment is resolved.
- Selection is isolated by session and project. Concurrent commands capture
  immutable selections. Conflicting switches fail instead of racing.
- Captured environments live only in process memory, scoped to the session.
  Clearing a selection restores normal harness/direnv behavior; deleting the
  session releases its captures. Preparation failures retain the previous shell.
- Only Linux and OpenCode's patched legacy `ShellTool` are supported. The V2
  core Bash implementation currently has no plugin environment hook and is
  unsupported. No fallback command runner is provided.

This is **not a sandbox**. Approved build scripts, hooks, binaries on PATH,
other plugins, and commands retain user authority. A trusted hook can read
mutable project files or perform side effects. Startup injection variables are
stripped from captured output, but this does not make an untrusted hook safe.
Permissions must not auto-allow `harbor_dev_shell_prepare` for arbitrary sources.
An agent with unrestricted writes to harness configuration could change policy;
that is outside the command prompt policy's security boundary.

## Approval and revisions

The registry is rendered by Home Manager into the Nix store. It has no agent-side
write or approve operation. Runtime approval is handled by OpenCode's ordinary
permission UI. New derivations produce distinct permission identities.

Editing a working tree does not silently update its registered shell. The
operator must evaluate and install a new registry to consume updated dev-shell
declarations/inputs. Code being compiled may remain dirty; the shell definition
remains pinned. There is no implicit "trust all future shell revisions" mode.

## Home Manager

### Project-direnv prototype for v2

`plugins/project-environment-prototype` is an **unconfigured feasibility
prototype**, not a replacement for the production adapter. It selects by
session and canonical flake root, discovers derivation-valued
`devShells.<system>` attributes, and runs the project's approved `.envrc` from
a clean, fixed baseline for each command. Selection does not edit project
files. Approval follows the operator-configured `direnvApproval` mode.

Owned projects can opt into named selection with an `.envrc` convention:

```bash
use flake ".#${PROJECT_DEV_SHELL:-default}"
export PROJECT_DEV_SHELL_ACTIVE="${PROJECT_DEV_SHELL:-default}"
```

Default/clear omits the selector; the project chooses its normal default.
The acknowledgement prevents silently ignoring a requested shell. Existing
`.envrc` exports/hooks remain authoritative. Unapproved files, failed captures,
missing choices and nix-direnv stale fallbacks reject the operation. Commands
capture the environment for their launch directory; a later `cd` does not
change it. Non-flake projects can use approved direnv but have no shell menu.

The prototype now uses a **proposed upstream shell hook API** with native
`sessionID` and a preparation `AbortSignal`. It sets the invocation's environment
directly: no session-global environment swapping, no shell-tool replacement,
and no serialization of running foreground commands. Preparation alone is
serialized per session so pending manual approvals are not duplicated.
Old upstream events lacking that context fail closed. Options are `roots`,
absolute `direnv`/`nix` paths, `system`, and a loopback `serverURL`; authentication
uses the managed backend's `OPENCODE_PASSWORD`. Operator slash commands are
`project-env-select` (`{"cwd":"/project","shell":"docs"}`) and
`project-env-clear` (`{"cwd":"/project"}`). Agent-side selection authorization
is not implemented by this prototype.

`direnvApproval` accepts `"auto"` (the default) or `"manual"`. In auto mode,
preparing an environment automatically runs native `direnv allow` for a new or
changed `.envrc` within configured project roots, then rechecks trust before
exporting it. Explicit `direnv deny` remains blocked in either mode and uses
the manual approval flow. Native direnv trust is user-wide; shell choices are
still session-scoped. Command permissions are not bypassed. The same mode
applies to preparation during select and clear, not catalog listing.

Use `{"direnvApproval":"manual"}` to retain the approval form/retry workflow.
Invalid modes fail configuration validation. In both modes preparation is
**lazy**: changing `.envrc` alone does not
interrupt a session or request approval. Reads/edits remain available and an
already-running command finishes with its captured environment. The next
command that needs an unapproved environment waits on a v2 session form before
spawning. Other preparation in that session waits behind it; existing processes
continue and completed work is not replayed.

In manual mode (or after explicit denial), the form identifies the canonical `.envrc` and its revision. Review and grant
trust using native `direnv allow`, then choose **Approved in direnv — retry**.
The form does not grant trust itself: every retry checks direnv again. Editing
while a form is pending cancels the obsolete form and resolves the current
revision. Declining rejects the held operation and suppresses repeat prompts
for that session/revision; it never falls back to the old environment. Caller
cancellation removes its pending form. This implements an execution barrier,
not a watcher that pauses reasoning or interrupts active jobs.

**Upstream dependency:** proposal `e11f63b2f743dc37da7621408a5b5486e2a9b2b4`
on [shell-hook-context](https://github.com/caniko/opencode/tree/shell-hook-context),
based on upstream `b8aa08f260130452dc87fbc20c2a4e2ff743e642`. It exposes validated
session identity and cancellation in both Promise and Effect shell APIs. Native
tests cover direct-user-shell identity and interruption before spawn. It is a
contribution branch, **not an upstream merge or a production dependency**.

The old registered-tool wrapper's direct-shell bypass is closed in that modified
candidate: both paths now wait at the same hook, and native command denial still
prevents side effects. This is not evidence that unmodified upstream is ready.
PTYs and formatters still need equivalent context/coverage; this entrypoint is
not yet an all-commands production policy. Canix does not apply this core patch.

Run the model-free native-executor canary against an explicit candidate:

```sh
node test/check-project-environment-v2.mjs /absolute/opencode /absolute/direnv /absolute/nix
```

For source testing, set `OPENCODE_SOURCE=/checkout` and pass the declared Bun
executable instead of `opencode`. The check uses isolated state and fixtures,
tests direct-shell approval plus native permission denial, and preserves its
redacted backend log. `PROJECT_ENV_PLUGIN` may select an exact packaged plugin
directory. It does not open production state or issue provider requests.

The Nix `environments` check supplies real direnv/Nix/Pkl binaries. Local resolver
tests run with `DIRENV_BIN=/absolute/direnv NIX_BIN=/absolute/nix node --test
test/project-environment.test.mjs`. Fixture flakes are evaluated but not built;
they test catalog selection and `.envrc` behavior, not nix-direnv realization.

### OpenCode v2 Pkl canary

The v1 environment adapter below is not the v2 entrypoint. For stock v2,
configure the packaged **directory** `lib/harbor-canix-llm/plugins/pkl` as
a plugin, with `node`, `executable`, and `roots` options containing absolute
operator-supplied paths. The plugin registers a local stdio MCP server through
`ctx.mcp.transform`; it does not register direct custom tools or patch OpenCode.

The native v2 MCP executor owns tool approval. Calls supply session identity
through `ai.opencode/sessionID` metadata, not model arguments. Missing metadata
is rejected. The implementation provides `pkl_hover`, `pkl_diagnostics`, and
`pkl_status` for saved files within configured roots. Roots bound direct file
access; they are not an OS sandbox or a guarantee about Pkl imports. Approval
authorizes the Pkl operation, not a promise to enforce every native read rule.

This is a canary integration: Harbor-selected environments and session-deletion
cleanup are not yet wired into the MCP process. It currently uses its baseline
environment and releases servers when the MCP connection closes. Do not replace
the production v1 environment adapter with this entrypoint.

Run `canix cache build .#checks.x86_64-linux.environments` to execute the tests
with packaged dependencies and the real pinned Pkl server. Direct local tests
also support `PKL_LSP_BIN=/absolute/path/pkl-lsp node --test test/*.test.mjs`.

After publishing and locking this flake, import
`inputs.harbor-canix-llm.homeManagerModules.default`. Minimal consumer:

```nix
{inputs, pkgs, ...}: {
  imports = [inputs.harbor-canix-llm.homeManagerModules.default];
  programs.opencode = {
    enable = true;
    package = inputs.harbor-canix-llm.lib.patchOpencode pkgs.opencode;
  };
  programs.harborCanixLlm = {
    enable = true;
    opencode.enable = true;
    projects.modde = {
      root = "/data/nvme0/can/canix/projects/repos/owned/rs-modde";
      shells = {
        default = inputs.modde.devShells.${pkgs.stdenv.hostPlatform.system}.default;
        docs = inputs.modde.devShells.${pkgs.stdenv.hostPlatform.system}.docs;
      };
    };
  };
}
```

Patch the real OpenCode derivation, not a launcher wrapper. Canix's scoped
launcher must carry `harborCanixLlmEnvironmentVersion = 1` in its passthru after
wrapping that patched runtime. The Home Manager assertion rejects an unmarked
package. The adapter also requires a runtime hook handshake before selection;
the package marker alone is not execution evidence.

The patch is targeted at Canix's `21105065b9e74d80f4f1c85b082e546ec9254791`
OpenCode source. That shipped revision does not have the local checkout's
uncommitted direnv loader. The patch introduces full-environment replacement
after normal command permission checks and preserves the shipped baseline when
no environment is selected. It neither loads nor auto-approves .envrc. A future
direnv integration must load only on the no-selection branch. The runtime wrapper
sets `HARBOR_CANIX_LLM_REQUIRE_LEGACY=1`; V2 Bash explicitly fails after permission
checking because that execution path has no replacement hook. Review patch
applicability and permission ordering when updating the harness. Do not enable
the adapter on unsupported runtimes or through a source that changes this order.

Restart OpenCode once after installing the module. Run an ordinary Bash call to
verify the replacement hook (a direnv rejection can still establish the hook
handshake). Then use `harbor_devshell` with `list`, `select`, `status`, or `clear`.
Changing a selection needs no restart. Direct `nix develop -c`, `direnv exec`,
and other command-wrapper permissions remain unchanged.

Preparation uses a fixed `nix develop <approved-drv> --profile <private-runtime-profile> --command <store-node>
<store-capture>` operation, with a timeout, output bound, and process-group
cancellation. Hook output and captured values are never included in tool
responses. Realized store paths are reused by Nix; captured environments are
not reused across sessions. Private runtime profiles retain toolchain GC roots
for the harness process lifetime; normal exit removes them, while a crash may
leave them until reboot. These profiles contain Nix store references, not
captured credentials. No cache publication or credential refresh is
performed by this adapter. Canix operators may pre-realize approved shells
through `canix cache build` under their normal private-cache policy.

Hooks that depend on an interactive TTY, leave background services running, or
export paths into Nix's disposable preparation directory are not supported.
Temporary-directory variables are reset after capture; arbitrary references
to transient files cannot be repaired automatically. Use persistent,
project-independent setup in language Harbor hooks, such as Harbor's Cargo cache.

## Checks

```sh
node --test test/*.test.mjs
node test/check-opencode.mjs /path/to/the-pinned-opencode-source
```

The second command patches temporary copies and verifies permission ordering,
full child environment replacement, and preservation of the harness OOM policy.
It does not modify the OpenCode checkout. Flake checks expose
the stdlib tests and the `harbor-meta` dev-shell check. Live OpenCode permission
denial, two-shell switching, and Rust compilation still require deploying the
patched runtime. Unit tests do not establish those live integration guarantees.
