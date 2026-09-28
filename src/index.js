/**
 * Reportli AI — Business Knowledge Worker
 *
 * ARCHITECTURE
 *
 * 1. Supabase inserts into business_data
 * 2. Supabase Database Webhook calls this Worker
 * 3. Webhook only accepts the event
 * 4. Webhook returns immediately
 * 5. Cloudflare Cron runs periodically
 * 6. Cron finds pending business_data rows
 * 7. Cron claims one row
 * 8. Worker sends data to Sarvam
 * 9. Worker saves knowledge to business_knowledge
 * 10. Worker marks business_data as completed
 *
 * REQUIRED SECRETS
 *
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * SARVAM_API_KEY
 *
 * Configure the Cron expression in Cloudflare:
 * Every 2 minutes
 */

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";

// Input / AI limits
const MAX_TEXT_CHARS = 20000;
const SARVAM_MAX_TOKENS = 4096;
const SARVAM_MAX_ATTEMPTS = 2;
const MIN_ATTEMPT_MS = 5000;
const MAX_FIELDS_PER_PAGE = 25;

// Cron processing
const CRON_BUDGET_MS = 90000;
const SAVE_RESERVE_MS = 5000;

// If a Worker crashes while a row is "processing",
// Cron can recover it after this amount of time.
const STALE_PROCESSING_MS = 4 * 60 * 1000;

// IMPORTANT:
// Process only ONE page per Cron invocation.
// This keeps Cloudflare subrequests under control.
const CRON_BATCH = 1;

export default {
  /**
   * HTTP handler
   *
   * Supabase Database Webhook calls this.
   *
   * IMPORTANT:
   * This handler DOES NOT call Sarvam.
   * It only accepts the event and leaves the row for Cron.
   */
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // Health check
    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "reportli-business-knowledge-worker",
        status: "healthy",
        architecture: "webhook-queue-cron-processor"
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        {
          ok: false,
          error: "Method not allowed"
        },
        405
      );
    }

    // Check secrets
    const missing = [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SARVAM_API_KEY"
    ].filter((key) => !env[key]);

    if (missing.length > 0) {
      console.error("Missing secrets:", missing.join(", "));

      return jsonResponse(
        {
          ok: false,
          error: `Missing secrets: ${missing.join(", ")}`
        },
        500
      );
    }

    // Parse webhook JSON
    let payload;

    try {
      payload = await request.json();
    } catch {
      return jsonResponse(
        {
          ok: false,
          error: "Invalid JSON"
        },
        400
      );
    }

    /**
     * Supabase Database Webhook sends the row directly.
     *
     * Example:
     *
     * {
     *   "id": "...",
     *   "application_id": "...",
     *   "field": "page",
     *   "data": {...},
     *   "source_url": "...",
     *   "ai_status": "pending"
     * }
     *
     * We also support wrapped formats just in case.
     */
    const record =
      (payload?.id &&
        payload?.application_id &&
        payload?.field &&
        payload) ||
      payload?.record ||
      payload?.new_record ||
      payload?.data?.record ||
      payload?.data?.new_record ||
      null;

    if (!record) {
      console.error(
        "Could not find business_data record. Payload keys:",
        Object.keys(payload || {})
      );

      return jsonResponse(
        {
          ok: false,
          error: "BUSINESS_DATA_RECORD_NOT_FOUND"
        },
        400
      );
    }

    /**
     * Detect event type.
     *
     * Supabase Database Webhooks normally contain:
     * INSERT / UPDATE / DELETE
     *
     * We only want INSERT.
     */
    const eventType = String(
      payload?.type ||
        payload?.event ||
        payload?.event_type ||
        "INSERT"
    ).toUpperCase();

    if (eventType !== "INSERT") {
      console.log(
        `Webhook event ${eventType} ignored for ${record.id}`
      );

      return jsonResponse({
        ok: true,
        queued: false,
        skipped: true,
        reason: `Event type ${eventType} ignored`
      });
    }

    // Only process webpage rows
    if (record.field !== "page") {
      console.log(
        `Webhook row ${record.id} ignored: field=${record.field}`
      );

      return jsonResponse({
        ok: true,
        queued: false,
        skipped: true,
        reason: "Only field=page is processed"
      });
    }

    if (!record.id) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing business_data id"
        },
        400
      );
    }

    console.log(
      `Webhook received. Queuing business_data ${record.id}`
    );

    /**
     * IMPORTANT:
     *
     * We do NOT call Sarvam here.
     * We do NOT use ctx.waitUntil() here.
     *
     * The database row remains pending.
     * Cron will pick it up.
     */

    return jsonResponse({
      ok: true,
      queued: true,
      id: record.id,
      message: "Row queued for Cron processing"
    });
  },

  /**
   * Cloudflare Cron handler
   *
   * Configure:
   *
   * */2 * * * *
   */
  async scheduled(event, env, ctx) {
    console.log("Cron started");

    try {
      await runCron(env);
    } catch (error) {
      console.error(
        "Cron crashed:",
        error?.stack || error?.message || String(error)
      );
    }

    console.log("Cron finished");
  }
};


/* =========================================================
   CRON
   ========================================================= */

async function runCron(env) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?field=eq.page` +
    `&select=id,ai_status,updated_at` +
    `&or=${encodeURIComponent(claimableFilter())}` +
    `&order=updated_at.asc` +
    `&limit=${CRON_BATCH}`;

  console.log("Cron querying pending rows");

  const response = await fetch(url, {
    method: "GET",
    headers: supabaseHeaders(env)
  });

  if (!response.ok) {
    const text = await response.text();

    console.error(
      "Cron query failed:",
      response.status,
      text
    );

    return;
  }

  const rows = await response.json();

  console.log(
    `Cron found ${rows.length} claimable row(s)`
  );

  if (!rows.length) {
    return;
  }

  /**
   * CRON_BATCH = 1
   *
   * Process exactly one page per Cron invocation.
   */
  for (const row of rows) {
    await processBusinessData(row.id, env);
  }
}


/* =========================================================
   CLAIMABLE ROW FILTER
   ========================================================= */

function claimableFilter() {
  const staleBefore = new Date(
    Date.now() - STALE_PROCESSING_MS
  ).toISOString();

  return (
    `(ai_status.eq.pending,` +
    `ai_status.is.null,` +
    `and(ai_status.eq.processing,updated_at.lt.${staleBefore}))`
  );
}


/* =========================================================
   PROCESS ONE BUSINESS_DATA ROW
   ========================================================= */

async function processBusinessData(id, env) {
  const deadline = Date.now() + CRON_BUDGET_MS;

  let claimed = false;

  console.log(
    `Starting processing for ${id}`
  );

  try {
    /**
     * Get the latest database row.
     */
    const row = await getBusinessData(id, env);

    if (!row) {
      throw new Error(
        "BUSINESS_DATA_RECORD_NOT_FOUND"
      );
    }

    console.log(
      `Found row ${id}: status=${row.ai_status}`
    );

    /**
     * Only process webpage rows.
     */
    if (row.field !== "page") {
      console.log(
        `Skipping ${id}: field=${row.field}`
      );

      return;
    }

    /**
     * Already completed or permanently failed.
     */
    if (
      row.ai_status === "completed" ||
      row.ai_status === "failed"
    ) {
      console.log(
        `Skipping ${id}: ai_status=${row.ai_status}`
      );

      return;
    }

    /**
     * Atomically claim the row.
     *
     * pending -> processing
     */
    claimed = await claimRow(id, env);

    if (!claimed) {
      console.log(
        `Could not claim ${id}; another process may already have it`
      );

      return;
    }

    console.log(
      `Claimed ${id}`
    );

    /**
     * Convert business_data.data into text.
     */
    const inputText = buildInputText(row.data);

    console.log(
      `Prepared ${inputText.length} characters for Sarvam`
    );

    /**
     * Send to Sarvam.
     */
    const knowledge = await extractKnowledge(
      inputText,
      row.source_url,
      env,
      deadline
    );

    console.log(
      `Sarvam returned ${knowledge.length} knowledge item(s)`
    );

    /**
     * Group and normalize fields.
     */
    const grouped = groupKnowledge(knowledge);

    console.log(
      `Grouped into ${grouped.size} field(s)`
    );

    /**
     * Save extracted knowledge.
     */
    if (grouped.size > 0) {
      await saveAll(
        row.application_id,
        grouped,
        row.source_url,
        env
      );
    } else {
      console.log(
        `No useful knowledge extracted from ${id}`
      );
    }

    /**
     * Mark source row completed.
     */
    await updateStatus(
      id,
      "completed",
      env,
      null
    );

    console.log(
      `SUCCESS: ${id} completed`
    );
  } catch (error) {
    console.error(
      `Processing failed for ${id}:`,
      error?.stack || error?.message || String(error)
    );

    /**
     * If we didn't claim the row,
     * don't change its status.
     */
    if (!claimed) {
      return;
    }

    /**
     * Cron owns the processing now.
     *
     * If Sarvam temporarily fails, keep the row pending
     * so the next Cron invocation can retry.
     *
     * If the error is permanent, mark failed.
     */
    try {
      if (error?.retriable) {
        await updateStatus(
          id,
          "pending",
          env,
          `Retry scheduled: ${error.message}`
        );

        console.log(
          `Row ${id} returned to pending for retry`
        );
      } else {
        await updateStatus(
          id,
          "failed",
          env,
          error?.message || String(error)
        );

        console.log(
          `Row ${id} marked failed`
        );
      }
    } catch (statusError) {
      console.error(
        "Could not update failure status:",
        statusError?.message || String(statusError)
      );
    }
  }
}


/* =========================================================
   GET BUSINESS_DATA
   ========================================================= */

async function getBusinessData(id, env) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&select=id,application_id,field,data,source_url,ai_status,ai_error,updated_at` +
    `&limit=1`;

  const response = await fetch(url, {
    method: "GET",
    headers: supabaseHeaders(env)
  });

  if (!response.ok) {
    throw new Error(
      `GET business_data failed: ` +
      `${response.status} ${await response.text()}`
    );
  }

  const rows = await response.json();

  return rows?.[0] || null;
}


/* =========================================================
   CLAIM ROW
   ========================================================= */

async function claimRow(id, env) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&or=${encodeURIComponent(claimableFilter())}`;

  const response = await fetch(url, {
    method: "PATCH",

    headers: {
      ...supabaseHeaders(env),
      "Prefer": "return=representation"
    },

    body: JSON.stringify({
      ai_status: "processing",
      ai_error: null,
      updated_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    throw new Error(
      `Could not claim row: ` +
      `${response.status} ${await response.text()}`
    );
  }

  const rows = await response.json();

  return (
    Array.isArray(rows) &&
    rows.length > 0
  );
}


/* =========================================================
   UPDATE BUSINESS_DATA STATUS
   ========================================================= */

async function updateStatus(
  id,
  status,
  env,
  errorMessage
) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}`;

  const response = await fetch(url, {
    method: "PATCH",

    headers: {
      ...supabaseHeaders(env),
      "Prefer": "return=minimal"
    },

    body: JSON.stringify({
      ai_status: status,

      ai_error: errorMessage
        ? String(errorMessage).slice(0, 2000)
        : null,

      updated_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    throw new Error(
      `Failed to update status: ` +
      `${response.status} ${await response.text()}`
    );
  }

  console.log(
    `business_data ${id} -> ${status}`
  );
}


/* =========================================================
   BUILD AI INPUT
   ========================================================= */

function buildInputText(data) {
  if (
    data === null ||
    data === undefined
  ) {
    throw new Error(
      "business_data.data is empty"
    );
  }

  let text =
    typeof data === "string"
      ? data
      : JSON.stringify(data);

  text = text
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) {
    throw new Error(
      "business_data.data contains no text"
    );
  }

  return text.slice(
    0,
    MAX_TEXT_CHARS
  );
}


/* =========================================================
   SARVAM EXTRACTION
   ========================================================= */

async function extractKnowledge(
  inputText,
  sourceUrl,
  env,
  deadline
) {
  const prompt = `Extract only the important business facts from this webpage text.

Return ONLY a JSON object. No markdown. No explanation.

Format:
{"knowledge":[{"field":"short_snake_case_name","data":"string, array, or object"}]}

Useful fields:
business_name
business_type
description
services
products
pricing
phone
email
address
hours
team
policies
faqs
social_media

Rules:
- Use only facts present in the text.
- Never invent anything.
- Ignore menus, navigation, footers, cookie notices, placeholders and demo content.
- One item per field.
- Use an array for lists.
- Use an object for structured data such as address.
- Keep values concise.
- If nothing useful is found, return {"knowledge":[]}.

SOURCE URL:
${sourceUrl || "unknown"}

WEBPAGE TEXT:
${inputText}`;

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= SARVAM_MAX_ATTEMPTS;
    attempt++
  ) {
    /**
     * Keep enough time available for Supabase saving.
     */
    const remaining =
      deadline -
      Date.now() -
      SAVE_RESERVE_MS;

    if (remaining < MIN_ATTEMPT_MS) {
      throw (
        lastError ||
        makeError(
          "Not enough time left to call Sarvam",
          true
        )
      );
    }

    console.log(
      `Sarvam attempt ${attempt} ` +
      `(timeout ${Math.round(remaining / 1000)}s)`
    );

    try {
      return await callSarvamOnce(
        prompt,
        env,
        remaining
      );
    } catch (error) {
      lastError = error;

      console.error(
        `Sarvam attempt ${attempt} failed:`,
        error?.message || String(error)
      );

      if (!error?.retriable) {
        throw error;
      }

      if (
        attempt < SARVAM_MAX_ATTEMPTS
      ) {
        await sleep(
          1000 * attempt
        );
      }
    }
  }

  throw (
    lastError ||
    makeError(
      "Sarvam extraction failed",
      true
    )
  );
}


/* =========================================================
   SINGLE SARVAM REQUEST
   ========================================================= */

async function callSarvamOnce(
  prompt,
  env,
  timeoutMs
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    let response;
    let responseText;

    try {
      response = await fetch(
        SARVAM_URL,
        {
          method: "POST",

          signal:
            controller.signal,

          headers: {
            "Content-Type":
              "application/json",

            "api-subscription-key":
              env.SARVAM_API_KEY
          },

          body: JSON.stringify({
            model: SARVAM_MODEL,

            messages: [
              {
                role: "user",
                content: prompt
              }
            ],

            temperature: 0,

            max_tokens:
              SARVAM_MAX_TOKENS
          })
        }
      );

      responseText =
        await response.text();
    } catch (error) {
      if (
        error?.name ===
        "AbortError"
      ) {
        throw makeError(
          `Sarvam timed out after ${Math.round(
            timeoutMs / 1000
          )}s`,
          true
        );
      }

      throw makeError(
        `Sarvam network error: ${
          error?.message || String(error)
        }`,
        true
      );
    }

    console.log(
      `Sarvam HTTP status: ${response.status}`
    );

    /**
     * HTTP errors.
     */
    if (!response.ok) {
      throw makeError(
        `Sarvam API ${response.status}: ` +
          responseText.slice(0, 500),

        [
          408,
          425,
          429,
          500,
          502,
          503,
          504
        ].includes(response.status)
      );
    }

    /**
     * Parse Sarvam response.
     */
    let result;

    try {
      result =
        JSON.parse(responseText);
    } catch {
      throw makeError(
        `Sarvam returned invalid JSON: ` +
          responseText.slice(0, 300),
        true
      );
    }

    const choice =
      result?.choices?.[0];

    const content =
      choice?.message?.content;

    if (!content) {
      throw makeError(
        `Sarvam returned empty content ` +
          `(finish_reason=${
            choice?.finish_reason ||
            "unknown"
          })`,
        choice?.finish_reason !== "length"
      );
    }

    /**
     * Parse model's JSON.
     */
    const parsed =
      parseSarvamJSON(content);

    const knowledge =
      normalizeKnowledge(parsed);

    if (!knowledge) {
      throw makeError(
        "Invalid Sarvam response format: knowledge array missing",
        true
      );
    }

    return knowledge;
  } finally {
    clearTimeout(timer);
  }
}


/* =========================================================
   ERROR HELPER
   ========================================================= */

function makeError(
  message,
  retriable
) {
  const error =
    new Error(message);

  error.retriable =
    retriable;

  return error;
}


/* =========================================================
   PARSE SARVAM JSON
   ========================================================= */

function parseSarvamJSON(content) {
  let text =
    String(content);

  /**
   * Remove thinking blocks.
   */
  text = text.replace(
    /<think>[\s\S]*?<\/think>/gi,
    ""
  );

  if (
    text.includes("</think>")
  ) {
    text =
      text.split("</think>").pop();
  }

  /**
   * Remove markdown fences.
   */
  text = text
    .replace(
      /^\s*```json\s*/i,
      ""
    )
    .replace(
      /^\s*```\s*/i,
      ""
    )
    .replace(
      /\s*```\s*$/i,
      ""
    )
    .trim();

  /**
   * First attempt:
   * parse the entire response.
   */
  try {
    return JSON.parse(text);
  } catch {}

  /**
   * Second attempt:
   * find JSON object inside response.
   */
  const start =
    text.indexOf("{");

  const end =
    text.lastIndexOf("}");

  if (
    start !== -1 &&
    end > start
  ) {
    try {
      return JSON.parse(
        text.slice(
          start,
          end + 1
        )
      );
    } catch (error) {
      throw makeError(
        `Could not parse Sarvam JSON: ${error.message}`,
        true
      );
    }
  }

  throw makeError(
    "Could not find JSON object in Sarvam response",
    true
  );
}


/* =========================================================
   NORMALIZE KNOWLEDGE
   ========================================================= */

function normalizeKnowledge(parsed) {
  /**
   * Already an array.
   */
  if (Array.isArray(parsed)) {
    return parsed;
  }

  /**
   * Standard format.
   */
  if (
    Array.isArray(
      parsed?.knowledge
    )
  ) {
    return parsed.knowledge;
  }

  /**
   * Support:
   *
   * {
   *   business_name: "...",
   *   services: [...]
   * }
   */
  if (
    isObject(parsed) &&
    !("knowledge" in parsed)
  ) {
    return Object.entries(
      parsed
    ).map(
      ([field, data]) => ({
        field,
        data
      })
    );
  }

  return null;
}


/* =========================================================
   GROUP KNOWLEDGE
   ========================================================= */

function groupKnowledge(items) {
  const grouped =
    new Map();

  for (const item of items) {
    if (
      !item ||
      typeof item.field !==
        "string"
    ) {
      continue;
    }

    const field =
      item.field
        .trim()
        .toLowerCase()
        .replace(
          /[^a-z0-9]+/g,
          "_"
        )
        .replace(
          /^_+|_+$/g,
          ""
        );

    if (
      !field ||
      isEmptyValue(item.data)
    ) {
      continue;
    }

    grouped.set(
      field,

      grouped.has(field)
        ? mergeValues(
            grouped.get(field),
            item.data
          )
        : item.data
    );

    if (
      grouped.size >=
      MAX_FIELDS_PER_PAGE
    ) {
      break;
    }
  }

  return grouped;
}


/* =========================================================
   EMPTY VALUE CHECK
   ========================================================= */

function isEmptyValue(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return true;
  }

  if (
    typeof value ===
    "string"
  ) {
    return (
      value.trim() === ""
    );
  }

  if (
    Array.isArray(value)
  ) {
    return value.length === 0;
  }

  if (
    isObject(value)
  ) {
    return (
      Object.keys(value)
        .length === 0
    );
  }

  return false;
}


/* =========================================================
   SAVE ALL KNOWLEDGE
   ========================================================= */

async function saveAll(
  applicationId,
  grouped,
  sourceUrl,
  env
) {
  const fields =
    [...grouped.keys()];

  console.log(
    `Preparing to save ${fields.length} knowledge field(s)`
  );

  /**
   * Fetch existing knowledge first.
   */
  const existingByField =
    await getExistingKnowledgeBatch(
      applicationId,
      fields,
      env
    );

  /**
   * Save fields.
   *
   * Promise.allSettled allows us to see
   * exactly which field failed.
   */
  const results =
    await Promise.allSettled(
      fields.map(
        (field) =>
          saveKnowledge(
            applicationId,
            field,
            grouped.get(field),
            existingByField.get(field) ||
              null,
            sourceUrl,
            env
          )
      )
    );

  const failed =
    results.filter(
      (result) =>
        result.status ===
        "rejected"
    );

  if (
    failed.length > 0
  ) {
    const firstError =
      failed[0].reason;

    throw new Error(
      `Failed to save ` +
        `${failed.length}/${results.length} ` +
        `knowledge items: ` +
        `${
          firstError?.message ||
          String(firstError)
        }`
    );
  }

  console.log(
    `Successfully saved ${fields.length} knowledge field(s)`
  );
}


/* =========================================================
   GET EXISTING KNOWLEDGE
   ========================================================= */

async function getExistingKnowledgeBatch(
  applicationId,
  fields,
  env
) {
  if (!fields.length) {
    return new Map();
  }

  /**
   * Fields are already sanitized by groupKnowledge()
   * to [a-z0-9_], so they are safe here.
   */
  const fieldList =
    fields.join(",");

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(
      applicationId
    )}` +
    `&field=in.(${encodeURIComponent(
      fieldList
    )})` +
    `&select=*`;

  const response =
    await fetch(url, {
      method: "GET",
      headers:
        supabaseHeaders(env)
    });

  if (!response.ok) {
    throw new Error(
      `GET business_knowledge failed: ` +
        `${response.status} ` +
        `${await response.text()}`
    );
  }

  const rows =
    await response.json();

  const map =
    new Map();

  for (const row of rows) {
    if (
      !map.has(row.field)
    ) {
      map.set(
        row.field,
        row
      );
    }
  }

  return map;
}


/* =========================================================
   GET ONE EXISTING KNOWLEDGE ROW
   ========================================================= */

async function getExistingKnowledge(
  applicationId,
  field,
  env
) {
  const map =
    await getExistingKnowledgeBatch(
      applicationId,
      [field],
      env
    );

  return (
    map.get(field) ||
    null
  );
}


/* =========================================================
   SAVE ONE KNOWLEDGE FIELD
   ========================================================= */

async function saveKnowledge(
  applicationId,
  field,
  newValue,
  existing,
  sourceUrl,
  env
) {
  const base =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge`;

  const now =
    new Date().toISOString();

  /**
   * Merge with existing knowledge.
   */
  const mergedData =
    existing &&
    existing.data !== null &&
    existing.data !== undefined
      ? mergeValues(
          existing.data,
          newValue
        )
      : newValue;

  /**
   * Merge source URLs.
   */
  const existingSources =
    Array.isArray(
      existing?.source_urls
    )
      ? existing.source_urls
      : [];

  const sourceUrls =
    [
      ...new Set(
        [
          ...existingSources,
          sourceUrl
        ].filter(Boolean)
      )
    ];

  /**
   * Existing row:
   * PATCH
   */
  if (existing?.id) {
    await writeKnowledge(
      "PATCH",
      `${base}?id=eq.${encodeURIComponent(
        existing.id
      )}`,
      {
        data: mergedData,
        source_urls: sourceUrls,
        updated_at: now
      },
      env
    );

    console.log(
      `Updated knowledge: ${field}`
    );

    return;
  }

  /**
   * New row:
   * INSERT
   */
  try {
    await writeKnowledge(
      "POST",
      base,
      {
        application_id:
          applicationId,

        field,

        data:
          mergedData,

        source_urls:
          sourceUrls,

        created_at:
          now,

        updated_at:
          now
      },
      env
    );

    console.log(
      `Inserted knowledge: ${field}`
    );
  } catch (error) {
    /**
     * Another request may have inserted
     * the same field at the same time.
     */
    if (
      error?.status ===
      409
    ) {
      console.log(
        `Conflict inserting ${field}; fetching existing row`
      );

      const current =
        await getExistingKnowledge(
          applicationId,
          field,
          env
        );

      if (current) {
        return saveKnowledge(
          applicationId,
          field,
          newValue,
          current,
          sourceUrl,
          env
        );
      }
    }

    throw error;
  }
}


/* =========================================================
   WRITE KNOWLEDGE
   ========================================================= */

async function writeKnowledge(
  method,
  url,
  body,
  env
) {
  const payload =
    { ...body };

  /**
   * These columns must exist.
   */
  const required = [
    "application_id",
    "field",
    "data"
  ];

  /**
   * Try a few times in case an optional
   * column doesn't exist in the database.
   */
  for (
    let i = 0;
    i < 4;
    i++
  ) {
    const response =
      await fetch(url, {
        method,

        headers: {
          ...supabaseHeaders(env),

          "Prefer":
            "return=minimal"
        },

        body:
          JSON.stringify(
            payload
          )
      });

    if (
      response.ok
    ) {
      return;
    }

    const text =
      await response.text();

    /**
     * Supabase/PostgREST missing column.
     */
    const missingColumn =
      text.match(
        /Could not find the '([^']+)' column/
      );

    if (
      response.status ===
        400 &&
      missingColumn &&
      missingColumn[1] in
        payload &&
      !required.includes(
        missingColumn[1]
      )
    ) {
      console.warn(
        `business_knowledge has no column "${missingColumn[1]}". Retrying without it.`
      );

      delete payload[
        missingColumn[1]
      ];

      continue;
    }

    const error =
      new Error(
        `business_knowledge ${method} failed: ` +
          `${response.status} ${text}`
      );

    error.status =
      response.status;

    throw error;
  }

  throw new Error(
    "business_knowledge write failed after column fallbacks"
  );
}


/* =========================================================
   MERGE VALUES
   ========================================================= */

function mergeValues(
  oldValue,
  newValue
) {
  /**
   * Arrays:
   * combine and remove duplicates.
   */
  if (
    Array.isArray(oldValue) ||
    Array.isArray(newValue)
  ) {
    return removeDuplicates(
      [
        ...toArray(oldValue),
        ...toArray(newValue)
      ]
    );
  }

  /**
   * Objects:
   * merge properties.
   */
  if (
    isObject(oldValue) &&
    isObject(newValue)
  ) {
    return {
      ...oldValue,
      ...newValue
    };
  }

  /**
   * Different primitive values:
   * keep both.
   */
  if (
    JSON.stringify(
      oldValue
    ) !==
    JSON.stringify(
      newValue
    )
  ) {
    return removeDuplicates(
      [
        oldValue,
        newValue
      ]
    );
  }

  return oldValue;
}


/* =========================================================
   ARRAY HELPER
   ========================================================= */

function toArray(value) {
  return Array.isArray(value)
    ? value
    : [value];
}


/* =========================================================
   REMOVE DUPLICATES
   ========================================================= */

function removeDuplicates(
  array
) {
  const seen =
    new Set();

  const result =
    [];

  for (
    const item of array
  ) {
    const key =
      item !== null &&
      typeof item ===
        "object"
        ? JSON.stringify(
            item
          )
        : String(item)
            .trim()
            .toLowerCase();

    if (
      !seen.has(key)
    ) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}


/* =========================================================
   OBJECT CHECK
   ========================================================= */

function isObject(value) {
  return (
    value !== null &&
    typeof value ===
      "object" &&
    !Array.isArray(value)
  );
}


/* =========================================================
   SUPABASE HEADERS
   ========================================================= */

function supabaseHeaders(
  env
) {
  return {
    "apikey":
      env.SUPABASE_SERVICE_ROLE_KEY,

    "Authorization":
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

    "Content-Type":
      "application/json"
  };
}


/* =========================================================
   JSON RESPONSE
   ========================================================= */

function jsonResponse(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        ...corsHeaders(),

        "Content-Type":
          "application/json"
      }
    }
  );
}


/* =========================================================
   CORS
   ========================================================= */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
  };
}


/* =========================================================
   SLEEP
   ========================================================= */

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
            }
