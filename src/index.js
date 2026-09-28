/**
 * Reportli AI — Business Knowledge Worker (fixed)
 *
 * Flow:
 *
 * business_data INSERT
 *   -> Supabase Database Webhook
 *   -> Worker (responds immediately, processes in background)
 *   -> fetch fresh row -> claim (pending -> processing)
 *   -> Sarvam AI (time-bounded)
 *   -> save to business_knowledge
 *   -> ai_status = completed
 *
 * Recovery:
 *   - If the web path runs out of time (Cloudflare kills background
 *     work ~30s after the response), the row is put back to "pending".
 *   - A cron trigger (scheduled handler) picks up pending rows and
 *     rows stuck in "processing" for > 4 minutes, and retries them
 *     with a much larger time budget.
 *
 * Required secrets:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SARVAM_API_KEY
 *
 * Required trigger (Worker -> Settings -> Triggers -> Cron):
 *   */2 * * * *
 */

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";

const MAX_TEXT_CHARS = 20000;      // smaller input = faster, fewer timeouts
const SARVAM_MAX_TOKENS = 4096;    // reasoning models spend tokens thinking
const SARVAM_MAX_ATTEMPTS = 3;
const MIN_ATTEMPT_MS = 5000;       // don't start a Sarvam call with less time than this
const MAX_FIELDS_PER_PAGE = 25;

const WEB_BUDGET_MS = 26000;       // waitUntil allows ~30s after response
const CRON_BUDGET_MS = 90000;      // cron gets far more wall time
const SAVE_RESERVE_MS = 5000;      // time kept back for saving after Sarvam
const STALE_PROCESSING_MS = 4 * 60 * 1000;
const CRON_BATCH = 2;              // use 1 on Workers Free (50 subrequest limit)


// ======================================================
// WORKER ENTRY
// ======================================================

export default {

  async fetch(request, env, ctx) {

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "reportli-business-knowledge-worker",
        status: "healthy"
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SARVAM_API_KEY"]
      .filter((key) => !env[key]);

    if (missing.length > 0) {
      console.error("Missing secrets:", missing.join(", "));
      return jsonResponse({ ok: false, error: `Missing secrets: ${missing.join(", ")}` }, 500);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
    }

    // The webhook is only a trigger. We just need the row id.
    const record =
      (payload?.id && payload?.application_id && payload?.field && payload) ||
      payload?.record ||
      payload?.new_record ||
      payload?.data?.record ||
      payload?.data?.new_record ||
      null;

    if (!record) {
      console.error("Could not find business_data record. Payload keys:", Object.keys(payload || {}));
      return jsonResponse({ ok: false, error: "BUSINESS_DATA_RECORD_NOT_FOUND" }, 400);
    }

    const eventType = String(
      payload?.type || payload?.event || payload?.event_type || "INSERT"
    ).toUpperCase();

    if (eventType !== "INSERT") {
      return jsonResponse({ ok: true, skipped: true, reason: `Event type ${eventType} ignored` });
    }

    if (record.field !== "page") {
      return jsonResponse({ ok: true, skipped: true, reason: "Only field=page is processed" });
    }

    if (!record.id) {
      return jsonResponse({ ok: false, error: "Missing business_data id" }, 400);
    }

    console.log(`Webhook received for business_data ${record.id}`);

    ctx.waitUntil(
      processBusinessData(record.id, env, {
        budgetMs: WEB_BUDGET_MS,
        deferOnRetriable: true
      }).catch((error) => console.error("Background processing crashed:", error))
    );

    return jsonResponse({ ok: true, received: true, id: record.id });
  },

  // Cron: retries deferred / stuck rows with a big time budget.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCron(env).catch((error) => console.error("Cron crashed:", error))
    );
  }

};


// ======================================================
// CRON RECOVERY
// ======================================================

async function runCron(env) {

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?field=eq.page` +
    `&select=id` +
    `&or=${encodeURIComponent(claimableFilter())}` +
    `&order=updated_at.asc` +
    `&limit=${CRON_BATCH}`;

  const response = await fetch(url, { method: "GET", headers: supabaseHeaders(env) });

  if (!response.ok) {
    console.error("Cron query failed:", response.status, await response.text());
    return;
  }

  const rows = await response.json();
  console.log(`Cron found ${rows.length} claimable rows`);

  for (const row of rows) {
    await processBusinessData(row.id, env, {
      budgetMs: CRON_BUDGET_MS,
      deferOnRetriable: false
    });
  }
}


// ======================================================
// MAIN PROCESSOR
// ======================================================

async function processBusinessData(id, env, { budgetMs, deferOnRetriable }) {

  const deadline = Date.now() + budgetMs;
  let claimed = false;

  console.log(`Processing ${id} (budget ${Math.round(budgetMs / 1000)}s)`);

  try {

    const row = await getBusinessData(id, env);

    if (!row) throw new Error("BUSINESS_DATA_RECORD_NOT_FOUND");

    if (row.field !== "page") {
      console.log(`Skipping ${id}: field=${row.field}`);
      return;
    }

    if (row.ai_status === "completed" || row.ai_status === "failed") {
      console.log(`Skipping ${id}: ai_status=${row.ai_status}`);
      return;
    }

    claimed = await claimRow(id, env);

    if (!claimed) {
      console.log(`Row ${id} is not claimable (already processing)`);
      return;
    }

    const inputText = buildInputText(row.data);
    console.log(`Sending ${inputText.length} chars to Sarvam`);

    const knowledge = await extractKnowledge(inputText, row.source_url, env, deadline);
    const grouped = groupKnowledge(knowledge);

    console.log(`Sarvam returned ${knowledge.length} items -> ${grouped.size} fields`);

    if (grouped.size > 0) {
      await saveAll(row.application_id, grouped, row.source_url, env);
    }

    await updateStatus(id, "completed", env, null);

    console.log(`Completed ${id} (${grouped.size} fields saved)`);

  } catch (error) {

    console.error(`Processing failed for ${id}:`, error);

    if (!claimed) return;

    try {
      if (deferOnRetriable && error.retriable) {
        // Hand over to cron, which has a much bigger time budget.
        await updateStatus(id, "pending", env, `Deferred to cron: ${error.message}`);
        console.log(`Row ${id} deferred to cron`);
      } else {
        await updateStatus(id, "failed", env, error?.message || String(error));
      }
    } catch (statusError) {
      console.error("Could not save status:", statusError);
    }
  }
}


// ======================================================
// INPUT TEXT
// ======================================================

function buildInputText(data) {

  if (data === null || data === undefined) {
    throw new Error("business_data.data is empty");
  }

  // Raw scraped text is a plain string: send it as-is.
  // (JSON.stringify on a string adds quotes/escapes and wastes tokens.)
  let text = typeof data === "string" ? data : JSON.stringify(data);

  text = text.replace(/\n{3,}/g, "\n\n").trim();

  if (!text) throw new Error("business_data.data contains no text");

  return text.slice(0, MAX_TEXT_CHARS);
}


// ======================================================
// SUPABASE: READ / CLAIM / STATUS
// ======================================================

async function getBusinessData(id, env) {

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&select=id,application_id,field,data,source_url,ai_status` +
    `&limit=1`;

  const response = await fetch(url, { method: "GET", headers: supabaseHeaders(env) });

  if (!response.ok) {
    throw new Error(`GET business_data failed: ${response.status} ${await response.text()}`);
  }

  const rows = await response.json();
  return rows?.[0] || null;
}

// A row can be claimed if it is pending, has no status, or has been
// stuck in "processing" longer than STALE_PROCESSING_MS (worker was killed).
function claimableFilter() {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  return `(ai_status.eq.pending,ai_status.is.null,and(ai_status.eq.processing,updated_at.lt.${staleBefore}))`;
}

async function claimRow(id, env) {

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&or=${encodeURIComponent(claimableFilter())}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: { ...supabaseHeaders(env), "Prefer": "return=representation" },
    body: JSON.stringify({
      ai_status: "processing",
      ai_error: null,
      updated_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    throw new Error(`Could not claim row: ${response.status} ${await response.text()}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function updateStatus(id, status, env, errorMessage) {

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data?id=eq.${encodeURIComponent(id)}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: { ...supabaseHeaders(env), "Prefer": "return=minimal" },
    body: JSON.stringify({
      ai_status: status,
      ai_error: errorMessage ? String(errorMessage).slice(0, 2000) : null,
      updated_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to update status: ${response.status} ${await response.text()}`);
  }

  console.log(`business_data ${id} -> ${status}`);
}


// ======================================================
// SARVAM AI
// ======================================================

async function extractKnowledge(inputText, sourceUrl, env, deadline) {

  const prompt = `Extract only the important business facts from this webpage text.

Return ONLY a JSON object. No markdown, no explanation:
{"knowledge":[{"field":"short_snake_case_name","data":"string, array, or object"}]}

Useful fields: business_name, business_type, description, services, products, pricing, phone, email, address, hours, team, policies, faqs, social_media.

Rules:
- Use only facts present in the text. Never invent anything.
- Ignore menus, navigation, footers, cookie notices, placeholders and demo content.
- One item per field. Use an array for lists and an object for structured data (e.g. address).
- Keep values concise.
- If nothing useful is found, return {"knowledge":[]}.

SOURCE URL: ${sourceUrl || "unknown"}

WEBPAGE TEXT:
${inputText}`;

  let lastError = null;

  for (let attempt = 1; attempt <= SARVAM_MAX_ATTEMPTS; attempt++) {

    const remaining = deadline - Date.now() - SAVE_RESERVE_MS;

    if (remaining < MIN_ATTEMPT_MS) {
      throw lastError || makeError("Not enough time left to call Sarvam", true);
    }

    try {
      console.log(`Sarvam attempt ${attempt} (timeout ${Math.round(remaining / 1000)}s)`);
      return await callSarvamOnce(prompt, env, remaining);
    } catch (error) {
      lastError = error;
      console.error(`Sarvam attempt ${attempt} failed:`, error.message);

      if (!error.retriable) throw error;

      if (attempt < SARVAM_MAX_ATTEMPTS) await sleep(1000 * attempt);
    }
  }

  throw lastError || makeError("Sarvam extraction failed", true);
}

async function callSarvamOnce(prompt, env, timeoutMs) {

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {

    let response;
    let responseText;

    try {
      response = await fetch(SARVAM_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": env.SARVAM_API_KEY
        },
        body: JSON.stringify({
          model: SARVAM_MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: SARVAM_MAX_TOKENS
        })
      });

      responseText = await response.text();

    } catch (error) {
      if (error.name === "AbortError") {
        throw makeError(`Sarvam timed out after ${Math.round(timeoutMs / 1000)}s`, true);
      }
      throw makeError(`Sarvam network error: ${error.message}`, true);
    }

    console.log(`Sarvam HTTP status: ${response.status}`);

    if (!response.ok) {
      throw makeError(
        `Sarvam API ${response.status}: ${responseText.slice(0, 500)}`,
        [429, 500, 502, 503, 504].includes(response.status)
      );
    }

    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      throw makeError(`Sarvam returned invalid JSON: ${responseText.slice(0, 300)}`, true);
    }

    const choice = result?.choices?.[0];
    const content = choice?.message?.content;

    if (!content) {
      throw makeError(
        `Sarvam returned empty content (finish_reason=${choice?.finish_reason || "unknown"})`,
        choice?.finish_reason !== "length"
      );
    }

    const parsed = parseSarvamJSON(content);
    const knowledge = normalizeKnowledge(parsed);

    if (!knowledge) {
      throw makeError("Invalid Sarvam response format: knowledge array missing", true);
    }

    return knowledge;

  } finally {
    clearTimeout(timer);
  }
}

function makeError(message, retriable) {
  const error = new Error(message);
  error.retriable = retriable;
  return error;
}

function parseSarvamJSON(content) {

  let text = String(content);

  // Reasoning models may include <think>...</think> before the answer.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (text.includes("</think>")) text = text.split("</think>").pop();

  text = text
    .replace(/^\s*```json\s*/i, "")
    .replace(/^\s*```\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(text);
  } catch {}

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (error) {
      throw makeError(`Could not parse Sarvam JSON: ${error.message}`, true);
    }
  }

  throw makeError("Could not find JSON object in Sarvam response", true);
}

// Accepts {"knowledge":[...]}, a bare array, or a flat {field: value} object.
function normalizeKnowledge(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.knowledge)) return parsed.knowledge;
  if (isObject(parsed) && !("knowledge" in parsed)) {
    return Object.entries(parsed).map(([field, data]) => ({ field, data }));
  }
  return null;
}


// ======================================================
// CLEAN + GROUP KNOWLEDGE
// ======================================================

function groupKnowledge(items) {

  const grouped = new Map();

  for (const item of items) {

    if (!item || typeof item.field !== "string") continue;

    const field = item.field
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    if (!field || isEmptyValue(item.data)) continue;

    grouped.set(
      field,
      grouped.has(field) ? mergeValues(grouped.get(field), item.data) : item.data
    );

    if (grouped.size >= MAX_FIELDS_PER_PAGE) break;
  }

  return grouped;
}

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}


// ======================================================
// SAVE TO business_knowledge
// ======================================================

async function saveAll(applicationId, grouped, sourceUrl, env) {

  const fields = [...grouped.keys()];

  // One request to load all existing rows for these fields
  // (keeps subrequest count low).
  const existingByField = await getExistingKnowledgeBatch(applicationId, fields, env);

  const results = await Promise.allSettled(
    fields.map((field) =>
      saveKnowledge(
        applicationId,
        field,
        grouped.get(field),
        existingByField.get(field) || null,
        sourceUrl,
        env
      )
    )
  );

  const failed = results.filter((r) => r.status === "rejected");

  if (failed.length > 0) {
    throw new Error(
      `Failed to save ${failed.length}/${results.length} knowledge items: ${failed[0].reason?.message}`
    );
  }
}

async function getExistingKnowledgeBatch(applicationId, fields, env) {

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=in.(${fields.join(",")})` +
    `&select=*`;

  const response = await fetch(url, { method: "GET", headers: supabaseHeaders(env) });

  if (!response.ok) {
    throw new Error(`GET business_knowledge failed: ${response.status} ${await response.text()}`);
  }

  const rows = await response.json();
  const map = new Map();

  for (const row of rows) {
    if (!map.has(row.field)) map.set(row.field, row);
  }

  return map;
}

async function getExistingKnowledge(applicationId, field, env) {
  const map = await getExistingKnowledgeBatch(applicationId, [field], env);
  return map.get(field) || null;
}

async function saveKnowledge(applicationId, field, newValue, existing, sourceUrl, env) {

  const base = `${env.SUPABASE_URL}/rest/v1/business_knowledge`;
  const now = new Date().toISOString();

  const mergedData =
    existing && existing.data !== null && existing.data !== undefined
      ? mergeValues(existing.data, newValue)
      : newValue;

  const existingSources = Array.isArray(existing?.source_urls) ? existing.source_urls : [];
  const sourceUrls = [...new Set([...existingSources, sourceUrl].filter(Boolean))];

  // UPDATE
  if (existing?.id) {
    await writeKnowledge(
      "PATCH",
      `${base}?id=eq.${encodeURIComponent(existing.id)}`,
      { data: mergedData, source_urls: sourceUrls, updated_at: now },
      env
    );
    return;
  }

  // INSERT
  try {
    await writeKnowledge(
      "POST",
      base,
      {
        application_id: applicationId,
        field,
        data: mergedData,
        source_urls: sourceUrls,
        created_at: now,
        updated_at: now
      },
      env
    );
  } catch (error) {
    // Another page inserted the same field first (unique constraint):
    // load that row and merge into it instead.
    if (error.status === 409) {
      const current = await getExistingKnowledge(applicationId, field, env);
      if (current) {
        return saveKnowledge(applicationId, field, newValue, current, sourceUrl, env);
      }
    }
    throw error;
  }
}

// Writes a row. If a non-essential column doesn't exist in the table
// (e.g. source_urls / created_at), drops it and retries instead of failing.
async function writeKnowledge(method, url, body, env) {

  const payload = { ...body };
  const required = ["application_id", "field", "data"];

  for (let i = 0; i < 4; i++) {

    const response = await fetch(url, {
      method,
      headers: { ...supabaseHeaders(env), "Prefer": "return=minimal" },
      body: JSON.stringify(payload)
    });

    if (response.ok) return;

    const text = await response.text();
    const missingColumn = text.match(/Could not find the '([^']+)' column/);

    if (
      response.status === 400 &&
      missingColumn &&
      missingColumn[1] in payload &&
      !required.includes(missingColumn[1])
    ) {
      console.warn(`business_knowledge has no column "${missingColumn[1]}", retrying without it`);
      delete payload[missingColumn[1]];
      continue;
    }

    const error = new Error(`business_knowledge ${method} failed: ${response.status} ${text}`);
    error.status = response.status;
    throw error;
  }

  throw new Error("business_knowledge write failed after column fallbacks");
}


// ======================================================
// MERGE HELPERS
// ======================================================

function mergeValues(oldValue, newValue) {

  if (Array.isArray(oldValue) || Array.isArray(newValue)) {
    return removeDuplicates([...toArray(oldValue), ...toArray(newValue)]);
  }

  if (isObject(oldValue) && isObject(newValue)) {
    return { ...oldValue, ...newValue };
  }

  if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
    return removeDuplicates([oldValue, newValue]);
  }

  return oldValue;
}

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}

function removeDuplicates(array) {

  const seen = new Set();
  const result = [];

  for (const item of array) {

    const key =
      item !== null && typeof item === "object"
        ? JSON.stringify(item)
        : String(item).trim().toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


// ======================================================
// UTILITIES
// ======================================================

function supabaseHeaders(env) {
  return {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
