import assert from "node:assert/strict";
import test from "node:test";
import { waitForEnvironmentApproval } from "../src/project-environment-v2.mjs";

const approval = { project: "/project", envrc: "/project/.envrc", revision: "revision", isCurrent: async () => true };

test("approval form waits for an explicit operator decision", async () => {
  const calls = [];
  const answer = await waitForEnvironmentApproval({
    sessionID: "ses_test", approval,
    request: async (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      if (method === "GET") return { data: { state: { status: "answered", answer: { decision: "retry" } } } };
    },
  });
  assert.equal(answer, "retry");
  assert.deepEqual(calls.map((call) => call.method), ["POST", "GET"]);
  assert.equal(calls[0].body.metadata.revision, "revision");
  assert.match(calls[0].body.fields[0].description, /Retrying alone does not grant trust/);
});

test("editing the definition cancels the obsolete form without approving it", async () => {
  const calls = [];
  const answer = await waitForEnvironmentApproval({
    sessionID: "ses_test", approval: { ...approval, isCurrent: async () => false },
    request: async (method) => { calls.push(method); },
  });
  assert.equal(answer, "retry");
  assert.deepEqual(calls, ["POST", "DELETE"]);
});

test("cancelling the held operation removes its pending form", async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(waitForEnvironmentApproval({
    sessionID: "ses_test", approval, signal: controller.signal,
    request: async (method) => {
      calls.push(method);
      if (method === "POST") controller.abort();
    },
  }), { name: "AbortError" });
  assert.deepEqual(calls, ["POST", "DELETE"]);
});
