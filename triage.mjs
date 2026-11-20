export const MODEL_TIMEOUT_MS = 300;
export const TOPICS = new Set(["delivery", "pricing", "other"]);

function isBlank(value) {
  return typeof value !== "string" || value.trim() === "";
}

function parseObject(raw) {
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Request body -> trimmed text, or null when the input is unusable.
export function parseRequestText(rawBody) {
  const body = parseObject(rawBody);
  if (body === null || isBlank(body.text)) return null;
  return body.text.trim();
}

// Raw model reply -> { topic, draft }, or null when it is not fit to show.
export function parseModelReply(raw) {
  if (typeof raw !== "string") return null;
  const reply = parseObject(raw);
  if (reply === null) return null;
  const { topic, draft } = reply;
  if (!TOPICS.has(topic) || isBlank(draft)) return null;
  return { topic, draft: draft.trim() };
}

function manualReview(reason) {
  console.warn("[triage] manual_review:", reason);
  return { status: "manual_review", topic: null, draft: null };
}

// Never throws: any model failure becomes manual_review.
export async function triage(text, { classify, timeoutMs = MODEL_TIMEOUT_MS }) {
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The race keeps the deadline even if the model ignores the signal.
  const deadline = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  let raw;
  try {
    raw = await Promise.race([classify(text, { signal }), deadline]);
  } catch {
    return manualReview(signal.aborted ? "timeout" : "model_error");
  } finally {
    clearTimeout(timer);
  }
  const reply = parseModelReply(raw);
  if (reply === null) return manualReview("bad_output");
  return { status: "ready", topic: reply.topic, draft: reply.draft };
}
