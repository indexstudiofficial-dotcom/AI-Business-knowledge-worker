/**
 * Reportli AI
 * Business Knowledge Worker
 *
 * Supabase business_data
 *        ↓
 * Supabase Database Webhook
 *        ↓
 * Cloudflare Worker
 *        ↓
 * Sarvam AI
 *        ↓
 * business_knowledge
 */

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL = "sarvam-105b";

const MAX_TEXT_CHARS = 40000;

const SARVAM_MAX_RETRIES = 2;


// ======================================================
// WORKER
// ======================================================

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
        service: "ai-business-knowledge-worker",
        status: "running"
      });
    }


    // --------------------------------------------------
    // Only POST
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
    // Read JSON
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
    // Supabase sends the business_data row directly.
    //
    // Also support wrapped formats just in case.
    // --------------------------------------------------

    const record =
      (
        payload?.id &&
        payload?.application_id &&
        payload?.field &&
        payload
      )
      ||
      payload?.record
      ||
      payload?.new_record
      ||
      payload?.data?.record
      ||
      payload?.data?.new_record
      ||
      null;


    // --------------------------------------------------
    // Record missing
    // --------------------------------------------------

    if (!record) {

      console.error(
        "BUSINESS_DATA_RECORD_NOT_FOUND"
      );

      return jsonResponse(
        {
          ok: false,
          error: "BUSINESS_DATA_RECORD_NOT_FOUND"
        },
        400
      );
    }


    // --------------------------------------------------
    // Only INSERT events
    //
    // We don't want UPDATE webhooks because this Worker
    // itself updates ai_status.
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
        reason: `Ignored event type: ${eventType}`
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


    // --------------------------------------------------
    // ID required
    // --------------------------------------------------

    if (!record.id) {

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
      processBusinessData(
        record.id,
        env
      )
    );


    // --------------------------------------------------
    // Respond immediately
    // --------------------------------------------------

    return jsonResponse({
      ok: true,
      received: true,
      id: record.id
    });
  }
};


// ======================================================
// MAIN PROCESS
// ======================================================

async function processBusinessData(id, env) {

  console.log(
    `Processing business_data: ${id}`
  );


  try {

    // --------------------------------------------------
    // Get fresh database row
    // --------------------------------------------------

    const row =
      await getBusinessData(id, env);


    if (!row) {

      throw new Error(
        "BUSINESS_DATA_RECORD_NOT_FOUND"
      );
    }


    // --------------------------------------------------
    // Only page
    // --------------------------------------------------

    if (row.field !== "page") {

      console.log(
        `Skipping ${id}: field=${row.field}`
      );

      return;
    }


    // --------------------------------------------------
    // Only pending rows
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
    // Claim row
    // --------------------------------------------------

    const claimed =
      await claimRow(id, env);


    if (!claimed) {

      console.log(
        `Row ${id} already processed or processing`
      );

      return;
    }


    // --------------------------------------------------
    // Validate data
    // --------------------------------------------------

    if (!row.data) {

      throw new Error(
        "business_data.data is empty"
      );
    }


    // --------------------------------------------------
    // Convert webpage data to text
    // --------------------------------------------------

    const inputText =
      JSON.stringify(
        row.data,
        null,
        2
      ).slice(
        0,
        MAX_TEXT_CHARS
      );


    console.log(
      `Sending ${inputText.length} characters to Sarvam`
    );


    // --------------------------------------------------
    // Extract knowledge
    // --------------------------------------------------

    const knowledge =
      await extractKnowledge(
        inputText,
        env
      );


    console.log(
      `Sarvam returned ${knowledge.length} fields`
    );


    // --------------------------------------------------
    // Save each knowledge field
    // --------------------------------------------------

    for (const item of knowledge) {

      if (!item) {
        continue;
      }

      if (!item.field) {
        continue;
      }

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


    // --------------------------------------------------
    // Completed
    // --------------------------------------------------

    await updateStatus(
      id,
      "completed",
      env
    );


    console.log(
      `SUCCESS: ${id}`
    );

  } catch (error) {

    console.error(
      `FAILED: ${id}`,
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
        error?.message ||
          String(error)
      );

    } catch (statusError) {

      console.error(
        "Could not save ai_error:",
        statusError
      );
    }
  }
}


// ======================================================
// GET FRESH BUSINESS DATA
// ======================================================

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
    await fetch(url, {
      method: "GET",
      headers: supabaseHeaders(env)
    });


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


// ======================================================
// CLAIM PENDING ROW
// ======================================================

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
    await fetch(url, {

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
    });


  if (!response.ok) {

    const text =
      await response.text();

    throw new Error(
      `Could not claim row: ${response.status} ${text}`
    );
  }


  const rows =
    await response.json();


  return (
    Array.isArray(rows) &&
    rows.length > 0
  );
}


// ======================================================
// SARVAM
// ======================================================

async function extractKnowledge(
  inputText,
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

Extract useful facts such as business name, description, phone, email, address, hours, services, products, prices, policies and FAQs.

Do not invent facts.

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


      const responseText =
        await response.text();


      if (!response.ok) {

        throw new Error(
          `Sarvam API ${response.status}: ${responseText}`
        );
      }


      let result;


      try {

        result =
          JSON.parse(responseText);

      } catch {

        throw new Error(
          `Invalid Sarvam API response: ${responseText}`
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
        parseSarvamJSON(content);


      if (
        !parsed ||
        !Array.isArray(parsed.knowledge)
      ) {

        throw new Error(
          "Invalid Sarvam knowledge format"
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


// ======================================================
// PARSE SARVAM JSON
// ======================================================

function parseSarvamJSON(
  content
) {

  let text =
    String(content).trim();


  // Remove markdown fences

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


  // Direct JSON

  try {

    return JSON.parse(text);

  } catch {}


  // Find JSON object

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
    "Could not parse Sarvam JSON"
  );
}


// ======================================================
// SAVE KNOWLEDGE
// ======================================================

async function saveKnowledge(
  applicationId,
  field,
  newValue,
  sourceUrl,
  env
) {

  // --------------------------------------------------
  // Find existing knowledge
  // --------------------------------------------------

  const existingUrl =
    `${env.SUPABASE_URL}` +
    `/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}` +
    `&select=id,data,source_urls` +
    `&limit=1`;


  const existingResponse =
    await fetch(
      existingUrl,
      {
        method: "GET",
        headers: supabaseHeaders(env)
      }
    );


  if (!existingResponse.ok) {

    const text =
      await existingResponse.text();

    throw new Error(
      `Knowledge lookup failed: ${existingResponse.status} ${text}`
    );
  }


  const existingRows =
    await existingResponse.json();


  const existing =
    existingRows?.[0] || null;


  // --------------------------------------------------
  // Merge data
  // --------------------------------------------------

  let mergedData =
    newValue;


  if (
    existing &&
    existing.data !== undefined
  ) {

    mergedData =
      mergeValues(
        existing.data,
        newValue
      );
  }


  // --------------------------------------------------
  // Merge source URLs
  // --------------------------------------------------

  const oldSources =
    Array.isArray(
      existing?.source_urls
    )
      ? existing.source_urls
      : [];


  const sourceUrls =
    [
      ...new Set(
        [
          ...oldSources,
          ...(sourceUrl
            ? [sourceUrl]
            : [])
        ].filter(Boolean)
      )
    ];


  // --------------------------------------------------
  // Upsert
  // --------------------------------------------------

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


  console.log(
    `Knowledge saved: ${applicationId}/${field}`
  );
}


// ======================================================
// MERGE VALUES
// ======================================================

function mergeValues(
  oldValue,
  newValue
) {

  // Arrays

  if (
    Array.isArray(oldValue) &&
    Array.isArray(newValue)
  ) {

    return removeDuplicates([
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


  // Different scalar values

  return removeDuplicates([
    oldValue,
    newValue
  ]);
}


// ======================================================
// REMOVE DUPLICATES
// ======================================================

function removeDuplicates(
  array
) {

  const seen =
    new Set();

  const result =
    [];


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
// UPDATE STATUS
// ======================================================

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

    ai_status:
      status,

    updated_at:
      new Date().toISOString()
  };


  // Success = clear previous error

  if (
    status === "completed"
  ) {

    body.ai_error = null;
  }


  // Failure = save error

  if (
    status === "failed"
  ) {

    body.ai_error =
      String(
        errorMessage ||
        "Unknown error"
      ).slice(
        0,
        2000
      );
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
// CORS
// ======================================================

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


// ======================================================
// SLEEP
// ======================================================

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
      }
