const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL = "sarvam-105b";

const MAX_TEXT_CHARS = 40000;
const SARVAM_MAX_RETRIES = 2;

export default {
  async fetch(request, env, ctx) {

    // -----------------------------
    // CORS
    // -----------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // -----------------------------
    // Health check
    // -----------------------------

    if (request.method === "GET") {
      return json({
        ok: true,
        service: "ai-business-knowledge-worker",
        status: "running"
      });
    }

    // -----------------------------
    // POST only
    // -----------------------------

    if (request.method !== "POST") {
      return json(
        {
          ok: false,
          error: "Method not allowed"
        },
        405
      );
    }

    // -----------------------------
    // Read webhook
    // -----------------------------

    let payload;

    try {
      payload = await request.json();
    } catch {
      return json(
        {
          ok: false,
          error: "Invalid JSON"
        },
        400
      );
    }

    console.log(
      "Webhook:",
      JSON.stringify(payload)
    );

    // -----------------------------
    // Supabase sends the row
    // directly at the root.
    //
    // Also support wrapped payloads.
    // -----------------------------

    const record =
      (
        payload?.id &&
        payload?.application_id &&
        payload?.field
      )
        ? payload
        : (
            payload?.record ||
            payload?.new_record ||
            payload?.data?.record ||
            payload?.data?.new_record ||
            null
          );

    if (!record) {
      console.error(
        "BUSINESS_DATA_RECORD_NOT_FOUND"
      );

      return json(
        {
          ok: false,
          error: "BUSINESS_DATA_RECORD_NOT_FOUND"
        },
        400
      );
    }

    // -----------------------------
    // Only page records
    // -----------------------------

    if (record.field !== "page") {
      return json({
        ok: true,
        skipped: true,
        reason: "Only page records are processed"
      });
    }

    // -----------------------------
    // Process asynchronously
    // -----------------------------

    ctx.waitUntil(
      processRecord(
        record.id,
        env
      )
    );

    // -----------------------------
    // Respond immediately
    // -----------------------------

    return json({
      ok: true,
      received: true,
      id: record.id
    });
  }
};


// =====================================================
// PROCESS RECORD
// =====================================================

async function processRecord(id, env) {

  console.log(
    `Processing ${id}`
  );

  try {

    // -----------------------------
    // Fetch fresh row
    // -----------------------------

    const row =
      await getBusinessData(
        id,
        env
      );

    if (!row) {
      throw new Error(
        "BUSINESS_DATA_RECORD_NOT_FOUND"
      );
    }

    // -----------------------------
    // Only pending rows
    // -----------------------------

    if (
      row.ai_status !== "pending" &&
      row.ai_status !== null
    ) {
      console.log(
        `Skipping ${id}. Status: ${row.ai_status}`
      );

      return;
    }

    // -----------------------------
    // Claim row
    // -----------------------------

    const claimed =
      await claimRow(
        id,
        env
      );

    if (!claimed) {
      console.log(
        `Row ${id} already claimed`
      );

      return;
    }

    // -----------------------------
    // Validate data
    // -----------------------------

    if (!row.data) {
      throw new Error(
        "business_data.data is empty"
      );
    }

    // -----------------------------
    // Prepare AI input
    // -----------------------------

    const input =
      JSON.stringify(
        row.data,
        null,
        2
      ).slice(
        0,
        MAX_TEXT_CHARS
      );

    // -----------------------------
    // Sarvam
    // -----------------------------

    const knowledge =
      await extractKnowledge(
        input,
        env
      );

    console.log(
      `Extracted ${knowledge.length} fields`
    );

    // -----------------------------
    // Save knowledge
    // -----------------------------

    for (const item of knowledge) {

      if (!item) continue;

      if (!item.field) continue;

      if (item.data === undefined) {
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

    // -----------------------------
    // SUCCESS
    // -----------------------------

    await updateStatus(
      id,
      "completed",
      env
    );

    console.log(
      `Completed ${id}`
    );

  } catch (error) {

    console.error(
      `Failed ${id}:`,
      error
    );

    try {

      await updateStatus(
        id,
        "failed",
        env,
        error?.message ||
          String(error)
      );

    } catch (statusError) {

      console.error(
        "Failed to save error:",
        statusError
      );
    }
  }
}


// =====================================================
// GET BUSINESS DATA
// =====================================================

async function getBusinessData(
  id,
  env
) {

  const url =
    `${env.SUPABASE_URL}` +
    `/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&select=id,application_id,field,data,source_url,ai_status` +
    `&limit=1`;

  const response =
    await fetch(
      url,
      {
        headers:
          supabaseHeaders(env)
      }
    );

  if (!response.ok) {

    const text =
      await response.text();

    throw new Error(
      `Supabase GET failed: ${response.status} ${text}`
    );
  }

  const rows =
    await response.json();

  return rows?.[0] || null;
}


// =====================================================
// CLAIM PENDING ROW
// =====================================================

async function claimRow(
  id,
  env
) {

  const url =
    `${env.SUPABASE_URL}` +
    `/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&ai_status=eq.pending`;

  const response =
    await fetch(
      url,
      {
        method: "PATCH",

        headers: {
          ...supabaseHeaders(env),
          "Prefer":
            "return=representation"
        },

        body: JSON.stringify({
          ai_status: "processing",
          ai_error: null,
          updated_at:
            new Date().toISOString()
        })
      }
    );

  if (!response.ok) {

    const text =
      await response.text();

    throw new Error(
      `Claim failed: ${response.status} ${text}`
    );
  }

  const rows =
    await response.json();

  return (
    Array.isArray(rows) &&
    rows.length > 0
  );
}


// =====================================================
// SARVAM
// =====================================================

async function extractKnowledge(
  input,
  env
) {

  const prompt = `
Extract useful business facts from this webpage data.

Return ONLY JSON:
{
  "knowledge": [
    {
      "field": "string",
      "data": "value"
    }
  ]
}

Extract business name, description, phone, email, address, hours, services, products, prices, policies and FAQs.

Do not invent facts.

WEBPAGE DATA:
${input}
`;

  let lastError;

  for (
    let attempt = 0;
    attempt <= SARVAM_MAX_RETRIES;
    attempt++
  ) {

    try {

      console.log(
        `Sarvam attempt ${attempt + 1}`
      );

      const response =
        await fetch(
          SARVAM_URL,
          {
            method: "POST",

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

              temperature: 0
            })
          }
        );

      const text =
        await response.text();

      if (!response.ok) {

        throw new Error(
          `Sarvam ${response.status}: ${text}`
        );
      }

      let result;

      try {
        result = JSON.parse(text);
      } catch {
        throw new Error(
          `Invalid Sarvam response: ${text}`
        );
      }

      const content =
        result?.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error(
          "Sarvam returned empty content"
        );
      }

      const parsed =
        parseAIJSON(content);

      if (
        !parsed ||
        !Array.isArray(
          parsed.knowledge
        )
      ) {
        throw new Error(
          "Invalid knowledge format"
        );
      }

      return parsed.knowledge;

    } catch (error) {

      lastError = error;

      console.error(
        `Sarvam attempt ${attempt + 1} failed`,
        error
      );

      if (
        attempt < SARVAM_MAX_RETRIES
      ) {
        await sleep(
          1000 * (attempt + 1)
        );
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "Sarvam extraction failed"
    )
  );
}


// =====================================================
// PARSE AI JSON
// =====================================================

function parseAIJSON(content) {

  let text =
    String(content).trim();

  text =
    text
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();

  try {
    return JSON.parse(text);
  } catch {}

  const start =
    text.indexOf("{");

  const end =
    text.lastIndexOf("}");

  if (
    start !== -1 &&
    end !== -1 &&
    end > start
  ) {

    return JSON.parse(
      text.slice(
        start,
        end + 1
      )
    );
  }

  throw new Error(
    "Could not parse AI JSON"
  );
}


// =====================================================
// SAVE BUSINESS KNOWLEDGE
// =====================================================

async function saveKnowledge(
  applicationId,
  field,
  newData,
  sourceUrl,
  env
) {

  // -----------------------------
  // Existing knowledge
  // -----------------------------

  const lookupUrl =
    `${env.SUPABASE_URL}` +
    `/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}` +
    `&select=id,data,source_urls` +
    `&limit=1`;

  const lookup =
    await fetch(
      lookupUrl,
      {
        headers:
          supabaseHeaders(env)
      }
    );

  if (!lookup.ok) {

    const text =
      await lookup.text();

    throw new Error(
      `Knowledge lookup failed: ${lookup.status} ${text}`
    );
  }

  const rows =
    await lookup.json();

  const existing =
    rows?.[0] || null;

  // -----------------------------
  // Merge data
  // -----------------------------

  const mergedData =
    existing?.data !== undefined
      ? mergeValues(
          existing.data,
          newData
        )
      : newData;

  // -----------------------------
  // Merge URLs
  // -----------------------------

  const oldUrls =
    Array.isArray(
      existing?.source_urls
    )
      ? existing.source_urls
      : [];

  const sourceUrls =
    [
      ...new Set(
        [
          ...oldUrls,
          ...(sourceUrl
            ? [sourceUrl]
            : [])
        ].filter(Boolean)
      )
    ];

  // -----------------------------
  // Upsert
  // -----------------------------

  const url =
    `${env.SUPABASE_URL}` +
    `/rest/v1/business_knowledge` +
    `?on_conflict=application_id,field`;

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          ...supabaseHeaders(env),

          "Prefer":
            "resolution=merge-duplicates,return=minimal"
        },

        body: JSON.stringify([
          {
            application_id:
              applicationId,

            field,

            data:
              mergedData,

            source_urls:
              sourceUrls,

            updated_at:
              new Date().toISOString()
          }
        ])
      }
    );

  if (!response.ok) {

    const text =
      await response.text();

    throw new Error(
      `Knowledge save failed: ${response.status} ${text}`
    );
  }
}


// =====================================================
// MERGE DATA
// =====================================================

function mergeValues(
  oldValue,
  newValue
) {

  // Arrays

  if (
    Array.isArray(oldValue) &&
    Array.isArray(newValue)
  ) {

    return unique([
      ...oldValue,
      ...newValue
    ]);
  }

  // Objects

  if (
    isObject(oldValue) &&
    isObject(newValue)
  ) {

    return {
      ...oldValue,
      ...newValue
    };
  }

  // Same value

  if (
    JSON.stringify(oldValue) ===
    JSON.stringify(newValue)
  ) {
    return oldValue;
  }

  // Different values

  return unique([
    oldValue,
    newValue
  ]);
}


// =====================================================
// UNIQUE
// =====================================================

function unique(values) {

  const seen =
    new Set();

  const output =
    [];

  for (const value of values) {

    const key =
      typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

    if (!seen.has(key)) {

      seen.add(key);
      output.push(value);
    }
  }

  return output;
}


// =====================================================
// OBJECT CHECK
// =====================================================

function isObject(value) {

  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}


// =====================================================
// UPDATE STATUS
// =====================================================

async function updateStatus(
  id,
  status,
  env,
  errorMessage = null
) {

  const url =
    `${env.SUPABASE_URL}` +
    `/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}`;

  const body = {
    ai_status: status,
    updated_at:
      new Date().toISOString()
  };

  if (status === "completed") {
    body.ai_error = null;
  }

  if (status === "failed") {
    body.ai_error =
      String(
        errorMessage ||
        "Unknown error"
      ).slice(0, 2000);
  }

  const response =
    await fetch(
      url,
      {
        method: "PATCH",

        headers: {
          ...supabaseHeaders(env),
          "Prefer":
            "return=minimal"
        },

        body:
          JSON.stringify(body)
      }
    );

  if (!response.ok) {

    const text =
      await response.text();

    throw new Error(
      `Status update failed: ${response.status} ${text}`
    );
  }
}


// =====================================================
// SUPABASE HEADERS
// =====================================================

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


// =====================================================
// RESPONSE
// =====================================================

function json(
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


// =====================================================
// CORS
// =====================================================

function corsHeaders() {

  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
  };
}


// =====================================================
// SLEEP
// =====================================================

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
        }
