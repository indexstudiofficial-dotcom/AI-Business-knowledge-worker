/**
 * Reportli AI — Business Knowledge Worker
 *
 * Flow:
 * business_data INSERT
 *       ↓
 * Supabase Webhook
 *       ↓
 * Cloudflare Worker
 *       ↓
 * Fetch fresh business_data row
 *       ↓
 * Sarvam AI
 *       ↓
 * Merge into business_knowledge
 *       ↓
 * ai_status = completed
 *
 * Required Worker secrets:
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * SARVAM_API_KEY
 */

const MAX_TEXT_CHARS = 40000;
const SARVAM_MAX_RETRIES = 2;
const SARVAM_MODEL = "sarvam-105b";

export default {
  async fetch(request, env, ctx) {
    // --------------------------------------------------
    // CORS
    // --------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // --------------------------------------------------
    // Health check
    // --------------------------------------------------

    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "reportli-business-knowledge-worker"
      });
    }

    // --------------------------------------------------
    // Webhook only accepts POST
    // --------------------------------------------------

    if (request.method !== "POST") {
      return jsonResponse(
        {
          ok: false,
          error: "Method not allowed"
        },
        405
      );
    }

    // --------------------------------------------------
    // Read webhook body
    // --------------------------------------------------

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

    console.log(
      "Webhook received:",
      JSON.stringify(payload)
    );

    // --------------------------------------------------
    // Supabase can send the row directly at root level.
    // Also support common wrapped formats.
    // --------------------------------------------------

    const record =
      (
        payload?.id &&
        payload?.application_id &&
        payload?.field &&
        payload
      ) ||
      payload?.record ||
      payload?.new_record ||
      payload?.data?.record ||
      payload?.data?.new_record ||
      null;

    if (!record) {
      console.error("Could not find business_data record");

      return jsonResponse(
        {
          ok: false,
          error: "BUSINESS_DATA_RECORD_NOT_FOUND"
        },
        400
      );
    }

    // --------------------------------------------------
    // Only process INSERT events
    // --------------------------------------------------

    const eventType =
      payload?.type ||
      payload?.event ||
      payload?.event_type ||
      "INSERT";

    if (eventType !== "INSERT") {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: `Event type ${eventType} ignored`
      });
    }

    // --------------------------------------------------
    // Only process page records
    // --------------------------------------------------

    if (record.field !== "page") {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "Only field=page is processed"
      });
    }

    const rowId = record.id;

    if (!rowId) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing business_data id"
        },
        400
      );
    }

    // --------------------------------------------------
    // Process in background
    // --------------------------------------------------

    ctx.waitUntil(
      processBusinessData(rowId, env).catch((error) => {
        console.error(
          "Background processing failed:",
          error
        );
      })
    );

    // --------------------------------------------------
    // Respond immediately to Supabase
    // --------------------------------------------------

    return jsonResponse({
      ok: true,
      received: true,
      id: rowId
    });
  }
};


// ======================================================
// MAIN PROCESSOR
// ======================================================

async function processBusinessData(id, env) {
  console.log(`Starting processing: ${id}`);

  try {
    // --------------------------------------------------
    // Fetch the latest row from Supabase
    // --------------------------------------------------

    const row = await getBusinessData(id, env);

    if (!row) {
      throw new Error(
        "BUSINESS_DATA_RECORD_NOT_FOUND"
      );
    }

    // --------------------------------------------------
    // Only process page
    // --------------------------------------------------

    if (row.field !== "page") {
      console.log(
        `Skipping ${id}: field=${row.field}`
      );

      return;
    }

    // --------------------------------------------------
    // Only process pending rows
    // --------------------------------------------------

    if (
      row.ai_status !== "pending" &&
      row.ai_status !== null
    ) {
      console.log(
        `Skipping ${id}: ai_status=${row.ai_status}`
      );

      return;
    }

    // --------------------------------------------------
    // Claim the row
    // --------------------------------------------------

    const claimed = await claimRow(id, env);

    if (!claimed) {
      console.log(
        `Row ${id} was already claimed`
      );

      return;
    }

    // --------------------------------------------------
    // Get page data
    // --------------------------------------------------

    const pageData = row.data;

    if (!pageData) {
      throw new Error(
        "business_data.data is empty"
      );
    }

    // --------------------------------------------------
    // Convert data to text
    // --------------------------------------------------

    const inputText = JSON.stringify(
      pageData,
      null,
      2
    ).slice(0, MAX_TEXT_CHARS);

    console.log(
      `Sending ${inputText.length} characters to Sarvam`
    );

    // --------------------------------------------------
    // Ask Sarvam
    // --------------------------------------------------

    const knowledge =
      await extractKnowledge(
        inputText,
        env
      );

    // --------------------------------------------------
    // Save extracted knowledge
    // --------------------------------------------------

    for (const item of knowledge) {
      if (
        !item ||
        !item.field ||
        item.data === undefined
      ) {
        continue;
      }

      await saveKnowledge(
        row.application_id,
        item.field,
        item.data,
        row.source_url,
        env
      );
    }

    // --------------------------------------------------
    // Mark completed
    // --------------------------------------------------

    await updateStatus(
      id,
      "completed",
      env,
      null
    );

    console.log(
      `Completed successfully: ${id}`
    );

  } catch (error) {

    console.error(
      `Processing failed for ${id}:`,
      error
    );

    // --------------------------------------------------
    // Save error
    // --------------------------------------------------

    try {
      await updateStatus(
        id,
        "failed",
        env,
        error?.message || String(error)
      );
    } catch (statusError) {
      console.error(
        "Could not save failure status:",
        statusError
      );
    }
  }
}


// ======================================================
// GET BUSINESS DATA
// ======================================================

async function getBusinessData(id, env) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&select=id,application_id,field,data,source_url,ai_status` +
    `&limit=1`;

  const response = await fetch(url, {
    method: "GET",
    headers: supabaseHeaders(env)
  });

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Supabase GET business_data failed: ${response.status} ${text}`
    );
  }

  const rows = await response.json();

  return rows?.[0] || null;
}


// ======================================================
// CLAIM ROW
// ======================================================

async function claimRow(id, env) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&ai_status=eq.pending`;

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
    const text = await response.text();

    throw new Error(
      `Could not claim business_data row: ${response.status} ${text}`
    );
  }

  const rows = await response.json();

  return Array.isArray(rows) && rows.length > 0;
}


// ======================================================
// SARVAM AI
// ======================================================

async function extractKnowledge(
  inputText,
  env
) {
  const url =
    "https://api.sarvam.ai/v1/chat/completions";

  const prompt = `
Extract useful business knowledge from this webpage data.

Return ONLY valid JSON:
{
  "knowledge": [
    {
      "field": "string",
      "data": "value"
    }
  ]
}

Keep only useful facts such as business name, description, phone, email, address, hours, services, products, pricing, policies, and FAQs.

Do not invent information.

WEBPAGE DATA:
${inputText}
`;

  let lastError = null;

  for (
    let attempt = 0;
    attempt <= SARVAM_MAX_RETRIES;
    attempt++
  ) {
    try {
      console.log(
        `Sarvam attempt ${attempt + 1}`
      );

      const response = await fetch(url, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
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

          temperature: 0
        })
      });

      const responseText =
        await response.text();

      if (!response.ok) {
        throw new Error(
          `Sarvam API ${response.status}: ${responseText}`
        );
      }

      const result =
        JSON.parse(responseText);

      const content =
        result?.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error(
          "Sarvam returned empty content"
        );
      }

      const parsed =
        parseSarvamJSON(content);

      if (
        !parsed ||
        !Array.isArray(parsed.knowledge)
      ) {
        throw new Error(
          "Invalid Sarvam response format"
        );
      }

      return parsed.knowledge;

    } catch (error) {
      lastError = error;

      console.error(
        `Sarvam attempt ${attempt + 1} failed:`,
        error
      );

      if (
        attempt < SARVAM_MAX_RETRIES
      ) {
        // Small retry delay
        await sleep(
          1000 * (attempt + 1)
        );
      }
    }
  }

  throw lastError ||
    new Error("Sarvam extraction failed");
}


// ======================================================
// PARSE SARVAM JSON
// ======================================================

function parseSarvamJSON(content) {
  let text = content.trim();

  // Remove markdown code fences
  text = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // First attempt
  try {
    return JSON.parse(text);
  } catch {}

  // Try extracting first JSON object
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (
    start !== -1 &&
    end !== -1 &&
    end > start
  ) {
    const jsonText =
      text.slice(start, end + 1);

    return JSON.parse(jsonText);
  }

  throw new Error(
    "Could not parse Sarvam JSON"
  );
}


// ======================================================
// SAVE / MERGE BUSINESS KNOWLEDGE
// ======================================================

async function saveKnowledge(
  applicationId,
  field,
  newValue,
  sourceUrl,
  env
) {
  // --------------------------------------------------
  // Get existing knowledge
  // --------------------------------------------------

  const existingUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}` +
    `&select=id,data,source_urls` +
    `&limit=1`;

  const existingResponse =
    await fetch(existingUrl, {
      method: "GET",
      headers: supabaseHeaders(env)
    });

  if (!existingResponse.ok) {
    const text =
      await existingResponse.text();

    throw new Error(
      `Failed to get existing knowledge: ${existingResponse.status} ${text}`
    );
  }

  const existingRows =
    await existingResponse.json();

  const existing =
    existingRows?.[0] || null;

  // --------------------------------------------------
  // Merge data
  // --------------------------------------------------

  let mergedData = newValue;

  if (existing?.data !== undefined) {
    mergedData = mergeValues(
      existing.data,
      newValue
    );
  }

  // --------------------------------------------------
  // Merge source URLs
  // --------------------------------------------------

  const existingSources =
    Array.isArray(existing?.source_urls)
      ? existing.source_urls
      : [];

  const sourceUrls = [
    ...new Set(
      [
        ...existingSources,
        ...(sourceUrl ? [sourceUrl] : [])
      ].filter(Boolean)
    )
  ];

  // --------------------------------------------------
  // Save
  // --------------------------------------------------

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?on_conflict=application_id,field`;

  const response = await fetch(url, {
    method: "POST",

    headers: {
      ...supabaseHeaders(env),
      "Prefer": "resolution=merge-duplicates,return=minimal"
    },

    body: JSON.stringify([
      {
        application_id: applicationId,
        field,
        data: mergedData,
        source_urls: sourceUrls,
        updated_at:
          new Date().toISOString()
      }
    ])
  });

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Failed to save business knowledge: ${response.status} ${text}`
    );
  }

  console.log(
    `Saved knowledge: ${applicationId} / ${field}`
  );
}


// ======================================================
// MERGE VALUES
// ======================================================

function mergeValues(
  oldValue,
  newValue
) {
  // --------------------------------------------------
  // Arrays
  // --------------------------------------------------

  if (
    Array.isArray(oldValue) &&
    Array.isArray(newValue)
  ) {
    const combined = [
      ...oldValue,
      ...newValue
    ];

    return removeDuplicates(
      combined
    );
  }

  // --------------------------------------------------
  // Objects
  // --------------------------------------------------

  if (
    isObject(oldValue) &&
    isObject(newValue)
  ) {
    return {
      ...oldValue,
      ...newValue
    };
  }

  // --------------------------------------------------
  // If values are different types,
  // preserve both.
  // --------------------------------------------------

  if (
    JSON.stringify(oldValue) !==
    JSON.stringify(newValue)
  ) {
    return removeDuplicates([
      oldValue,
      newValue
    ]);
  }

  return oldValue;
}


// ======================================================
// REMOVE DUPLICATES
// ======================================================

function removeDuplicates(array) {
  const seen = new Set();
  const result = [];

  for (const item of array) {
    const key =
      typeof item === "object"
        ? JSON.stringify(item)
        : String(item);

    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}


// ======================================================
// OBJECT CHECK
// ======================================================

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}


// ======================================================
// UPDATE BUSINESS DATA STATUS
// ======================================================

async function updateStatus(
  id,
  status,
  env,
  errorMessage
) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}`;

  const body = {
    ai_status: status,
    updated_at:
      new Date().toISOString()
  };

  // Clear old error when successful
  if (status === "completed") {
    body.ai_error = null;
  }

  // Save error when failed
  if (status === "failed") {
    body.ai_error =
      String(
        errorMessage ||
        "Unknown processing error"
      ).slice(0, 2000);
  }

  const response = await fetch(url, {
    method: "PATCH",

    headers: {
      ...supabaseHeaders(env),
      "Prefer": "return=minimal"
    },

    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Failed to update status: ${response.status} ${text}`
    );
  }
}


// ======================================================
// SUPABASE HEADERS
// ======================================================

function supabaseHeaders(env) {
  return {
    "apikey":
      env.SUPABASE_SERVICE_ROLE_KEY,

    "Authorization":
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

    "Content-Type":
      "application/json"
  };
}


// ======================================================
// JSON RESPONSE
// ======================================================

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


// ======================================================
// CORS HEADERS
// ======================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
  };
}


// ======================================================
// SLEEP
// ======================================================

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
        }
