import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// node test/check-project-environment-v2.mjs <opencode> <direnv> <nix>
// For a source candidate: OPENCODE_SOURCE=/checkout and <opencode>=<bun>.
// Requires the proposed session-aware shell hook, not unmodified old v2.
const [opencode, direnv, nix] = process.argv.slice(2);
assert.ok([opencode,direnv,nix].every(value=>value && path.isAbsolute(value)), "supply absolute opencode, direnv and nix paths");
const sourceArgs = process.env.OPENCODE_SOURCE ? ["run", "--cwd", path.join(process.env.OPENCODE_SOURCE,"packages/cli"), "src/index.ts"] : [];
const root = await mkdtemp(path.join(os.tmpdir(),"project-env-v2-"));
const a = `${root}/a`, b = `${root}/b`, home = `${root}/home`, probe = `${root}/probe`;
for (const directory of [a, b, home, probe]) await mkdir(directory);
let password = randomBytes(24).toString("hex");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`, XDG_STATE_HOME: `${home}/state`, OPENCODE_PASSWORD: password, PROJECT_TEST_BASE: "backend-value" };
if (process.env.PROJECT_ENV_NATIVE_CREDENTIAL === "1") {
  assert.equal(sourceArgs.length, 0, "native credential probe requires a packaged executable");
  delete env.OPENCODE_PASSWORD;
  password = (await promisify(execFile)(opencode, ["service", "get", "password"], {env,cwd:a})).stdout.trim();
  assert.ok(password);
}
for (const name of Object.keys(env)) if (name.startsWith("DIRENV_")) delete env[name];
for (const project of [a, b]) {
  await writeFile(`${project}/flake.nix`, '{ outputs = {self}: { devShells.x86_64-linux = let shell = builtins.derivation {name="fixture-shell";system="x86_64-linux";builder="/bin/sh";}; in {default=shell;docs=shell;}; }; }');
  await writeFile(`${project}/.envrc`, `export PROJECT_TEST="${path.basename(project)}:\${PROJECT_DEV_SHELL:-default}"\nexport PROJECT_DEV_SHELL_ACTIVE="\${PROJECT_DEV_SHELL:-default}"\nunset PROJECT_TEST_BASE\n`);
  await promisify(execFile)(direnv, ["allow", project], { env });
}
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${socket.address().port}`;
await new Promise((resolve) => socket.close(resolve));
await writeFile(`${probe}/server.js`, `
import {writeFile} from "node:fs/promises";
export default {id:"canix.env-probe", async setup(ctx) {
 await ctx.command.transform(editor => editor.add({name:"env-probe", async execute({sessionID,prompt}) {
  const input = JSON.parse(prompt.text);
  const shell = (await ctx.tool.list()).find(tool => tool.name === "shell");
  if (!shell) throw new Error("missing native shell");
  const result = await shell.execute(input, {sessionID, agent:"code", messageID:"msg_env_probe", id:"call_env_probe", signal:new AbortController().signal, progress:async()=>{}});
  await writeFile(${JSON.stringify(root)} + "/result-" + input.tag + ".json", JSON.stringify(result));
 }}));
}};
`);
await writeFile(`${a}/opencode.json`, JSON.stringify({ plugins: [
  { package: process.env.PROJECT_ENV_PLUGIN ?? fileURLToPath(new URL("../plugins/project-environment-prototype", import.meta.url)), options: {roots:[a,b], direnv, nix, system:"x86_64-linux", serverURL:url, direnvApproval:"manual", opencode} },
  { package: probe },
] }));
const child = spawn(opencode, [...sourceArgs, "--print-logs", "serve", ...(process.env.PROJECT_ENV_NATIVE_CREDENTIAL === "1" ? ["--service"] : []), "--hostname", "127.0.0.1", "--port", new URL(url).port], {cwd:a, env, stdio:["ignore","pipe","pipe"]});
let log = "";
child.stdout.on("data", chunk => { log += chunk; });
child.stderr.on("data", chunk => { log += chunk; });
const closed = new Promise(resolve => child.once("close",resolve));
const headers = {Authorization:`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "Content-Type":"application/json"};
async function request(method, endpoint, body) {
  const response = await fetch(url + endpoint, {method,headers,body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}
try {
 for (let i=0;i<100 && !log.includes("server listening on");i++) await new Promise(resolve=>setTimeout(resolve,100));
 assert.match(log,/server listening on/);
 const query = new URLSearchParams({"location[directory]":a});
 await request("GET",`/api/config?${query}`);
 for (let i=0;i<100;i++) {
  const plugins = await request("GET",`/api/plugin?${query}`);
  if (plugins.data.some(p=>p.id==="canix.env-probe" && p.state.status==="active")) break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 const create = async (effect = "allow") => (await request("POST","/api/session",{location:{directory:a},permissions:[{action:"*",resource:"*",effect:"allow"},{action:"shell",resource:"*",effect}]})).data.id;
 const one = await create(), two = await create();
 const command = (session,name,text) => request("POST",`/api/session/${session}/command`,{name,text:JSON.stringify(text)});
 async function run(session,workdir,tag, shellCommand = "printf '%s|%s' \"$PROJECT_TEST\" \"$PROJECT_TEST_BASE\"") {
  await command(session,"env-probe",{command:shellCommand,workdir,tag});
  const result = JSON.parse(await readFile(`${root}/result-${tag}.json`,"utf8"));
  assert.equal(result.output.status,"completed",JSON.stringify(result));
  return result.output.output;
 }
  assert.match(await run(one,a,"default"),/a:default\|/);
 async function approveDuring(session, action) {
   const prior = new Set((await request("GET",`/api/session/${session}/form`)).data.map(item=>item.id));
   const pending = action().then(value=>({value}),error=>({error}));
   let approval;
   for(let i=0;i<100;i++) {
     approval=(await request("GET",`/api/session/${session}/form`)).data.find(item=>!prior.has(item.id));
     if(approval) break;
     await new Promise(resolve=>setTimeout(resolve,50));
   }
   assert.ok(approval,"selection operation must request native approval");
   await promisify(execFile)(direnv,["allow",a],{env});
   await request("POST",`/api/session/${session}/form/${approval.id}/reply`,{answer:{decision:"retry"}});
   const result=await pending;
   if(result.error) throw result.error;
 }
 await writeFile(`${a}/.envrc`,(await readFile(`${a}/.envrc`,"utf8"))+"\n# selected revision\n");
 await approveDuring(one,()=>command(one,"project-env-select",{cwd:a,shell:"docs"}));
 assert.match(await run(one,a,"selected"),/a:docs\|/);
 assert.doesNotMatch(await run(one,a,"removed"),/backend-value/);
 assert.match(await run(two,a,"isolated"),/a:default\|/);
 const [ra,rb] = await Promise.all([run(one,a,"parallel-a"),run(one,b,"parallel-b")]);
 assert.match(ra,/a:docs\|/); assert.match(rb,/b:default\|/);
 await writeFile(`${a}/.envrc`,(await readFile(`${a}/.envrc`,"utf8"))+"\n# cleared revision\n");
 await approveDuring(one,()=>command(one,"project-env-clear",{cwd:a}));
 assert.match(await run(one,a,"clear"),/a:default\|/);
 const finishing = run(one,a,"finishing",`printf started > '${root}/started'; while [ ! -f '${root}/release' ]; do sleep 0.05; done; printf 'finished:%s' "$PROJECT_TEST"`);
 for(let i=0;i<100;i++) {
  try { await readFile(`${root}/started`); break; } catch { await new Promise(resolve=>setTimeout(resolve,50)); }
 }
  assert.equal(await readFile(`${root}/started`,"utf8"),"started");
  // Unlike the former wrapper, a long foreground command in A does not
  // serialize a second command in B behind its completion.
  assert.match(await run(one,b,"while-a-running"),/b:default\|/);
 await writeFile(`${a}/.envrc`,'export PROJECT_TEST="intermediate-edit"\n');
 await writeFile(`${a}/.envrc`,'export PROJECT_TEST="after-approval"\nunset PROJECT_TEST_BASE\n');
 assert.deepEqual((await request("GET",`/api/session/${one}/form`)).data,[]);
 await writeFile(`${root}/release`,"");
 assert.match(await finishing,/finished:a:default/);
 assert.deepEqual((await request("GET",`/api/session/${one}/form`)).data,[]);
 const held = run(one,a,"after-approval");
 let form;
 for(let i=0;i<100;i++) {
  form=(await request("GET",`/api/session/${one}/form`)).data.find(item=>item.metadata.revision && item.metadata.envrc === `${a}/.envrc`);
  if(form) break;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 assert.ok(form,"new execution must request approval");
 assert.equal(form.metadata.envrc,`${a}/.envrc`);
 await assert.rejects(readFile(`${root}/result-after-approval.json`),{code:"ENOENT"});
 await promisify(execFile)(direnv,["allow",a],{env});
 await request("POST",`/api/session/${one}/form/${form.id}/reply`,{answer:{decision:"retry"}});
 assert.match(await held,/after-approval\|/);
 console.log("PASS: editing is lazy, running command finishes, new command waits for a real v2 form then resumes after native direnv approval");
 console.log("PASS: real native executor default/select/clear/tombstones/two projects/two sessions/concurrency");
  // With the proposed native hook API, direct user-shell execution now
  // enters the same approval barrier instead of using a stale session env.
 await writeFile(`${a}/.envrc`,'export PROJECT_TEST="unapproved-again"\n');
  const direct = request("POST",`/api/session/${one}/shell`,{command:`/bin/sh -c 'printf "%s" "$PROJECT_TEST" > "${root}/bypass"'`});
  let directForm;
  for(let i=0;i<100;i++) {
    directForm=(await request("GET",`/api/session/${one}/form`)).data.find(item=>item.id!==form.id);
    if(directForm) break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(directForm,"direct shell must request approval");
  await assert.rejects(readFile(`${root}/bypass`),{code:"ENOENT"});
  await promisify(execFile)(direnv,["allow",a],{env});
  await request("POST",`/api/session/${one}/form/${directForm.id}/reply`,{answer:{decision:"retry"}});
  await direct;
 for(let i=0;i<100;i++) {
  try { await readFile(`${root}/bypass`); break; } catch { await new Promise(resolve=>setTimeout(resolve,50)); }
 }
  assert.equal(await readFile(`${root}/bypass`,"utf8"),"unapproved-again");
  console.log("PASS WITH PROPOSED CORE CHANGE: direct user shell waits and uses the fresh approved environment");
  const denied = await create("deny");
  await assert.rejects(command(denied,"env-probe",{command:`printf denied > '${root}/denied'`,workdir:b,tag:"denied"}));
  await assert.rejects(readFile(`${root}/denied`),{code:"ENOENT"});
  console.log("PASS: native shell denial prevents command side effects");
  const deleting = await create();
  await writeFile(`${a}/.envrc`, 'export PROJECT_TEST="deleted-session"\n');
  const selecting = command(deleting,"project-env-select",{cwd:a,shell:"docs"}).then(()=>({ok:true}),error=>({error}));
  let deletionForm;
  for(let i=0;i<100;i++) {
    deletionForm=(await request("GET",`/api/session/${deleting}/form`)).data[0];
    if(deletionForm) break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(deletionForm,"selection must be waiting before deletion");
  await request("DELETE",`/api/session/${deleting}`);
  assert.ok((await selecting).error,"deletion must cancel the pending selection");
  console.log("PASS: select/clear use native forms; session deletion cancels pending selection");
} finally {
 child.kill("SIGTERM");
 const timer=setTimeout(()=>child.kill("SIGKILL"),5000);
 await closed; clearTimeout(timer);
 await writeFile(`${root}/backend.log`,log.replaceAll(password,"[redacted]"));
 console.log(`evidence: ${root}`);
}
