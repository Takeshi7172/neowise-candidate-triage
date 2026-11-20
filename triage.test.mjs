import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { MODEL_TIMEOUT_MS, parseModelReply, triage } from "./triage.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

let server;
let baseUrl;

before(async () => {
  process.env.PORT = "0"; // must be set before the import: the server listens on load
  ({ server } = await import("./server.mjs"));
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function post(rawBody) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
  return { status: response.status, body: await response.json() };
}

test("invalid input returns 400 invalid_input", async () => {
  const bodies = [
    "", "{", "null", "[]", '"x"', "42", "{}",
    '{"text":""}', '{"text":"  \\n"}', '{"text":123}', '{"text":null}', '{"text":["a"]}',
  ];
  for (const raw of bodies) {
    const reply = await post(raw);
    assert.equal(reply.status, 400, raw);
    assert.deepEqual(reply.body, { status: "invalid_input" }, raw);
  }
});

test("valid text returns 200 ready", async () => {
  const cases = [
    ["Когда будет доставка?", "delivery"],
    ["Какая цена?", "pricing"],
    ["Здравствуйте", "other"],
  ];
  for (const [text, topic] of cases) {
    const reply = await post(JSON.stringify({ text }));
    assert.equal(reply.status, 200, text);
    assert.deepEqual(reply.body, {
      status: "ready",
      topic,
      draft: "Спасибо за обращение. Уточним детали заявки.",
    }, text);
  }
});

test("model failure returns 200 manual_review", async () => {
  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    const reply = await post(JSON.stringify({ text: `Заявка ${marker}` }));
    assert.equal(reply.status, 200, marker);
    assert.deepEqual(reply.body, MANUAL_REVIEW, marker);
  }
});

test("[timeout] is cut at the 300 ms deadline", async () => {
  const started = performance.now();
  const reply = await post(JSON.stringify({ text: "Заявка [timeout]" }));
  const elapsed = performance.now() - started;
  assert.deepEqual(reply.body, MANUAL_REVIEW);
  assert.ok(elapsed >= 250 && elapsed < 600, `elapsed ${Math.round(elapsed)} ms`);
});

test("deadline holds when the model ignores abort", async () => {
  let seen;
  const classify = (_text, { signal }) => {
    seen = signal;
    return new Promise(() => {}); // never settles
  };
  assert.deepEqual(await triage("Заявка", { classify, timeoutMs: 50 }), MANUAL_REVIEW);
  assert.equal(seen.aborted, true);
  assert.equal(MODEL_TIMEOUT_MS, 300);
});

test("parseModelReply keeps only a valid topic and draft", () => {
  const unfit = [
    undefined,
    { topic: "delivery", draft: "x" },
    "null",
    "[]",
    '"x"',
    '{"topic":"delivery"}',
    '{"topic":"Delivery","draft":"x"}',
    '{"topic":"constructor","draft":"x"}',
    '{"topic":"delivery","draft":123}',
    '{"topic":"delivery","draft":" "}',
  ];
  for (const raw of unfit) assert.equal(parseModelReply(raw), null, String(raw));
  assert.deepEqual(
    parseModelReply('{"topic":"pricing","draft":" x ","status":"ready","extra":1}'),
    { topic: "pricing", draft: "x" },
  );
});
