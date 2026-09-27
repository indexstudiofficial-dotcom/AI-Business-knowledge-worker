// ============================================================
// AI BUSINESS KNOWLEDGE WORKER (fixed)
// ============================================================
//
// FLOW:
//
// Supabase business_data INSERT
//          ↓
// Supabase Database Webhook  (trigger only — payload may be
//                              truncated/stale for large rows)
//          ↓
// Cloudflare Worker
//          ↓ re-fetches the row FRESH by id
// Sarvam AI  (short prompt)
//          ↓
// business_knowledge
//          ↓
// business_data.ai_status = completed
//
// FIXES vs previous version:
// - The webhook payload is only used to get `id` / `application_id`
//   / `field`. The actual text we send to the AI is fetched fresh
//   with a GET on business_data?id=eq.<id> right before processing.
//   This is the main fix: Supabase webhook payloads can be
//   truncated or missing large `data` values, which was the
//   likely cause of intermittent failures / empty extractions.
// - Prompt shortened significantly (same rules, far fewer tokens).
// - MAX_TEXT_CHARS lowered from 100k to 40k — large inputs were
//   more likely to hit Sarvam token/timeout limits.
// - Added a small retry (2 attempts) around the Sarvam call for
//   transient 429/5xx errors instead of failing immediately.
// - ai_status set to "failed" with the error message stored, so
//   failures are visible in the table instead of only in logs.
// ============================================================

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";
const MAX_TEXT_CHARS = 40000;
const SARVAM_MAX_RETRIES = 2;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET") {
      return jsonResponse({
        success: true,
        worker: "ai-business-knowledge-worker",
        status: "alive",
        expected_webhook_method: "POST"
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ success: false, error: "Only POST requests are allowed" }, 405);
    }

    try {
      if (!env.SUPABASE_URL) throw new Error("SUPABASE_URL is missing");
      if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
      if (!env.SARVAM_API_KEY) throw new Error("SARVAM_API_KEY is missing");

      const rawBody = await request.text();
      if (!rawBody) throw new Error("Webhook request body is empty");

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        throw new Error("Webhook body is not valid JSON");
      }

      // Find the record reference in whatever shape the webhook sent it.
      const record =
        (payload?.id && payload?.application_id && payload?.field && payload) ||
        payload?.record ||
        payload?.new_record ||
        payload?.data?.record ||
        payload?.data?.new_record ||
        null;

      if (!record) {
        console.error("[WEBHOOK] Record not found in payload:", JSON.stringify(payload));
        return jsonResponse(
          { success: false, error: "Could not find business_data record in webhook payload" },
          400
        );
      }

      const eventType = payload?.type || payload?.event || payload?.operation || "INSERT";
      if (String(eventType).toUpperCase() !== "INSERT") {
        return jsonResponse({ success: true, skipped: true, reason: "Only INSERT events are processed" });
      }

      const tableName = payload?.table || payload?.table_name || "business_data";
      if (tableName !== "business_data") {
        return jsonResponse({ success: true, skipped: true, reason: "Not business_data table" });
      }

      const businessDataId = record.id;
      const applicationId = record.application_id;
      const field = record.field;
      const aiStatus = record.ai_status;

      if (!businessDataId) throw new Error("business_data record ID is missing");
      if (!applicationId) throw new Error("application_id is missing");
      if (!field) throw new Error("field is missing");

      if (field !== "page") {
        return jsonResponse({ success: true, skipped: true, reason: "Only field=page is processed" });
      }

      if (aiStatus && aiStatus !== "pending") {
        return jsonResponse({ success: true, skipped: true, reason: `ai_status is ${aiStatus}` });
      }

      await processBusinessData(businessDataId, applicationId, env);

      return jsonResponse({
        success: true,
        processed: true,
        business_data_id: businessDataId,
        application_id: applicationId
      });

    } catch (error) {
      console.error("[WORKER] ERROR:", error);
      return jsonResponse({ success: false, error: error?.message || String(error) }, 500);
    }
  },

  // Old queue consumer kept only so Cloudflare accepts the worker.
  async queue(batch) {
    for (const message of batch.messages) {
      message.ack();
    }
  }
};

// ============================================================
// PROCESS BUSINESS DATA
// ============================================================

async function processBusinessData(id, applicationId, env) {
  try {
    await updateStatus(id, "processing", env);

    // ----------------------------------------------------------
    // Always fetch the FRESH row instead of trusting the webhook
    // payload's `data` field, which can be truncated or stale.
    // ----------------------------------------------------------
    const freshRow = await fetchBusinessDataRow(id, env);

    if (!freshRow) {
      throw new Error(`business_data row ${id} not found on fresh fetch`);
    }

    let rawText;
    if (typeof freshRow.data === "string") {
      rawText = freshRow.data;
    } else if (freshRow.data !== null && freshRow.data !== undefined) {
      rawText = JSON.stringify(freshRow.data);
    } else {
      throw new Error("business_data.data is empty");
    }

    rawText = rawText.trim();
    if (!rawText) throw new Error("business_data.data contains no text");

    if (rawText.length > MAX_TEXT_CHARS) {
      rawText = rawText.substring(0, MAX_TEXT_CHARS);
    }

    const extractedData = await callSarvamWithRetry(
      rawText,
      freshRow.source_url || "",
      env
    );

    const fields = Object.entries(extractedData);
    if (fields.length === 0) {
      throw new Error("Sarvam extracted no business information");
    }

    for (const [field, value] of fields) {
      if (value === null || value === undefined || value === "") continue;
      await saveKnowledge(applicationId, field, value, env);
    }

    await updateStatus(id, "completed", env);

  } catch (error) {
    console.error("[PROCESS] ERROR:", error);

    try {
      await updateStatus(id, "failed", env, error.message);
    } catch (statusError) {
      console.error("[PROCESS] Failed to update status:", statusError);
    }

    throw error;
  }
}

// ============================================================
// FETCH FRESH ROW
// ============================================================

async function fetchBusinessDataRow(id, env) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&select=id,application_id,field,data,source_url,ai_status` +
    `&limit=1`;

  const response = await fetch(url, { method: "GET", headers: supabaseHeaders(env) });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Could not fetch fresh business_data row: ${errorText}`);
  }

  const rows = await response.json();
  return rows[0] || null;
}

// ============================================================
// CALL SARVAM (with retry)
// ============================================================

async function callSarvamWithRetry(rawText, sourceUrl, env) {
  let lastError;

  for (let attempt = 1; attempt <= SARVAM_MAX_RETRIES + 1; attempt++) {
    try {
      return await callSarvam(rawText, sourceUrl, env);
    } catch (error) {
      lastError = error;
      const retriable = /HTTP (429|500|502|503|504)/.test(error.message);

      if (!retriable || attempt > SARVAM_MAX_RETRIES) break;

      console.log(`[SARVAM] Retriable error, attempt ${attempt}. Retrying...`);
      await sleep(attempt * 1000);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// CALL SARVAM
// ============================================================

// Short, rule-dense prompt. Same constraints as before, far
// fewer tokens: less input cost, less chance of the model
// rambling or exceeding output limits.
const SYSTEM_PROMPT = `Extract real business information from raw website text.

Rules:
- Only use facts explicitly present in the text. Never invent or guess.
- Ignore navigation, menus, footers, templates, placeholders, Lorem Ipsum, and any example/demo contact info.
- Ignore content clearly belonging to a different business.
- Skip fields with no supporting text — do not include empty fields.
- Output ONLY a valid JSON object. No markdown, no explanations.

Possible fields (use only what's supported, add others if clearly present):
business_name, business_type, description, services, products, phone, email, address, city, state, country, postal_code, hours, team, owner, pricing, appointments, faqs, social_media, website, contact_information.

Use arrays for lists (e.g. services), objects for structured data (e.g. address).`;

async function callSarvam(rawText, sourceUrl, env) {
  const userPrompt = `SOURCE URL: ${sourceUrl || "Unknown"}\n\nRAW WEBSITE TEXT:\n${rawText}`;

  const response = await fetch(SARVAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": env.SARVAM_API_KEY
    },
    body: JSON.stringify({
      model: SARVAM_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 4096,
      response_format: { type: "json_object" }
    })
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseText}`);
  }

  let responseJson;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    throw new Error("Sarvam returned invalid JSON envelope");
  }

  let content = responseJson?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Sarvam response does not contain message content");
  }

  if (typeof content === "object") {
    return cleanExtractedObject(content);
  }

  content = content
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let extracted;
  try {
    extracted = JSON.parse(content);
  } catch {
    console.error("[SARVAM] Model returned invalid JSON:", content);
    throw new Error("Sarvam returned JSON that could not be parsed");
  }

  return cleanExtractedObject(extracted);
}

// ============================================================
// CLEAN SARVAM OUTPUT
// ============================================================

function cleanExtractedObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sarvam returned an invalid extraction object");
  }

  const result = {};

  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!rawKey) continue;

    const field = rawKey.trim().toLowerCase().replace(/\s+/g, "_");
    if (!field) continue;

    if (rawValue === null || rawValue === undefined || rawValue === "") continue;

    if (Array.isArray(rawValue)) {
      const cleanedArray = rawValue.filter((item) => item !== null && item !== undefined && item !== "");
      if (cleanedArray.length === 0) continue;
      result[field] = cleanedArray;
      continue;
    }

    result[field] = rawValue;
  }

  return result;
}

// ============================================================
// SAVE TO business_knowledge
// ============================================================

async function saveKnowledge(applicationId, field, value, env) {
  const existingUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}` +
    `&select=id,data` +
    `&limit=1`;

  const existingResponse = await fetch(existingUrl, { method: "GET", headers: supabaseHeaders(env) });

  if (!existingResponse.ok) {
    const errorText = await existingResponse.text();
    throw new Error(`Could not check business_knowledge: ${errorText}`);
  }

  const existingRows = await existingResponse.json();
  let finalValue = value;

  if (existingRows.length > 0 && Array.isArray(existingRows[0].data) && Array.isArray(value)) {
    finalValue = removeDuplicateValues([...existingRows[0].data, ...value]);
  } else if (
    existingRows.length > 0 &&
    isPlainObject(existingRows[0].data) &&
    isPlainObject(value)
  ) {
    finalValue = { ...existingRows[0].data, ...value };
  }

  const upsertUrl = `${env.SUPABASE_URL}/rest/v1/business_knowledge?on_conflict=application_id,field`;

  const response = await fetch(upsertUrl, {
    method: "POST",
    headers: {
      ...supabaseHeaders(env),
      "Prefer": "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      application_id: applicationId,
      field: field,
      data: finalValue,
      updated_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Could not save business_knowledge: ${errorText}`);
  }
}

// ============================================================
// UPDATE ai_status
// ============================================================

async function updateStatus(id, status, env, errorMessage = null) {
  const url = `${env.SUPABASE_URL}/rest/v1/business_data?id=eq.${encodeURIComponent(id)}`;

  const body = {
    ai_status: status,
    updated_at: new Date().toISOString()
  };

  if (errorMessage) {
    body.ai_error = errorMessage.slice(0, 2000);
  }

  const response = await fetch(url, {
    method: "PATCH",
    headers: { ...supabaseHeaders(env), "Prefer": "return=minimal" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Could not update ai_status: ${errorText}`);
  }
}

// ============================================================
// HELPERS
// ============================================================

function supabaseHeaders(env) {
  return {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
}

function removeDuplicateValues(array) {
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
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
