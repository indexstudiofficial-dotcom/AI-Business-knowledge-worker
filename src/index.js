/**
 * Reportli AI — Business Knowledge Worker
 *
 * Flow:
 *
 * business_data INSERT
 *       ↓
 * Supabase Database Webhook
 *       ↓
 * Cloudflare Worker
 *       ↓
 * Fetch fresh business_data row
 *       ↓
 * Claim row: pending → processing
 *       ↓
 * Sarvam AI
 *       ↓
 * Parse knowledge
 *       ↓
 * Insert / update business_knowledge
 *       ↓
 * ai_status = completed
 *
 * Required secrets:
 *
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * SARVAM_API_KEY
 */

const MAX_TEXT_CHARS = 40000;

const SARVAM_MAX_RETRIES = 2;

const SARVAM_MODEL = "sarvam-105b";


// ======================================================
// WORKER ENTRY
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
        service: "reportli-business-knowledge-worker",
        status: "healthy"
      });

    }


    // --------------------------------------------------
    // Only POST allowed for webhook
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
    // Read webhook JSON
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
    // Extract business_data record
    //
    // Supports:
    // 1. Direct root row
    // 2. payload.record
    // 3. payload.new_record
    // 4. payload.data.record
    // 5. payload.data.new_record
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

      console.error(
        "Could not find business_data record"
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
    // Detect event type
    // --------------------------------------------------

    const eventType =
      payload?.type ||
      payload?.event ||
      payload?.event_type ||
      "INSERT";


    console.log(
      `Webhook event type: ${eventType}`
    );


    // --------------------------------------------------
    // Only process INSERT
    // --------------------------------------------------

    if (eventType !== "INSERT") {

      console.log(
        `Ignoring event type: ${eventType}`
      );

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

      console.log(
        `Ignoring field: ${record.field}`
      );

      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "Only field=page is processed"
      });

    }


    // --------------------------------------------------
    // Validate ID
    // --------------------------------------------------

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
      processBusinessData(rowId, env)
        .catch((error) => {

          console.error(
            "Background processing failed:",
            error
          );

        })
    );


    // --------------------------------------------------
    // Respond immediately
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

  console.log(
    `Starting processing: ${id}`
  );


  try {

    // --------------------------------------------------
    // Fetch latest business_data row
    // --------------------------------------------------

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


    console.log(
      "Fetched business_data:",
      JSON.stringify({
        id: row.id,
        application_id: row.application_id,
        field: row.field,
        ai_status: row.ai_status,
        source_url: row.source_url
      })
    );


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
    // Only process pending or null
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
      await claimRow(
        id,
        env
      );


    if (!claimed) {

      console.log(
        `Row ${id} was already claimed`
      );

      return;

    }


    console.log(
      `Row ${id} claimed successfully`
    );


    // --------------------------------------------------
    // Get page data
    // --------------------------------------------------

    const pageData = row.data;


    if (
      pageData === null ||
      pageData === undefined
    ) {

      throw new Error(
        "business_data.data is empty"
      );

    }


    // --------------------------------------------------
    // Convert page data to text
    // --------------------------------------------------

    const inputText =
      JSON.stringify(
        pageData,
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
    // Extract knowledge using Sarvam
    // --------------------------------------------------

    const knowledge =
      await extractKnowledge(
        inputText,
        env
      );


    console.log(
      `Sarvam returned ${knowledge.length} knowledge items`
    );


    // --------------------------------------------------
    // Save every knowledge item
    // --------------------------------------------------

    let savedCount = 0;


    for (
      const item of knowledge
    ) {

      if (
        !item ||
        !item.field ||
        item.data === undefined
      ) {

        console.log(
          "Skipping invalid knowledge item:",
          JSON.stringify(item)
        );

        continue;

      }


      console.log(
        "Saving knowledge item:",
        JSON.stringify(item)
      );


      await saveKnowledge(
        row.application_id,
        item.field,
        item.data,
        row.source_url,
        env
      );


      savedCount++;

    }


    console.log(
      `Successfully saved ${savedCount} knowledge items`
    );


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
    // Save failure
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
        "Could not save failure status:",
        statusError
      );

    }

  }

}


// ======================================================
// GET BUSINESS DATA
// ======================================================

async function getBusinessData(
  id,
  env
) {

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&select=id,application_id,field,data,source_url,ai_status` +
    `&limit=1`;


  const response =
    await fetch(
      url,
      {
        method: "GET",
        headers:
          supabaseHeaders(env)
      }
    );


  if (!response.ok) {

    const text =
      await response.text();

    throw new Error(
      `Supabase GET business_data failed: ${response.status} ${text}`
    );

  }


  const rows =
    await response.json();


  return rows?.[0] || null;

}


// ======================================================
// CLAIM ROW
// ======================================================

async function claimRow(
  id,
  env
) {

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
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
      `Could not claim business_data row: ${response.status} ${text}`
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

Return ONLY valid JSON.

Required format:

{
  "knowledge": [
    {
      "field": "string",
      "data": "value"
    }
  ]
}

Extract useful facts such as:

- business name
- description
- phone
- email
- address
- hours
- services
- products
- pricing
- policies
- FAQs

Rules:

1. Do not invent information.
2. Only use information present in the webpage data.
3. Each useful fact should be a separate knowledge item.
4. "field" should be a short descriptive name.
5. "data" may be a string, number, array, or object when appropriate.
6. Return valid JSON only.
7. Do not use Markdown.
8. Do not include explanations outside the JSON.

WEBPAGE DATA:

${inputText}
`;


  let lastError = null;


  // --------------------------------------------------
  // Retry loop
  // --------------------------------------------------

  for (
    let attempt = 0;
    attempt <= SARVAM_MAX_RETRIES;
    attempt++
  ) {

    try {

      console.log(
        `Sarvam attempt ${attempt + 1}`
      );


      // ------------------------------------------------
      // Validate API key exists
      // ------------------------------------------------

      if (!env.SARVAM_API_KEY) {

        throw new Error(
          "SARVAM_API_KEY secret is missing"
        );

      }


      // ------------------------------------------------
      // Call Sarvam
      // ------------------------------------------------

      const response =
        await fetch(
          url,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              "api-subscription-key":
                env.SARVAM_API_KEY
            },

            body:
              JSON.stringify({

                model:
                  SARVAM_MODEL,

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


      console.log(
        `Sarvam HTTP status: ${response.status}`
      );


      // ------------------------------------------------
      // API error
      // ------------------------------------------------

      if (!response.ok) {

        throw new Error(
          `Sarvam API ${response.status}: ${responseText}`
        );

      }


      // ------------------------------------------------
      // Parse API response
      // ------------------------------------------------

      let result;

      try {

        result =
          JSON.parse(
            responseText
          );

      } catch {

        throw new Error(
          `Sarvam returned invalid JSON: ${responseText.slice(0, 2000)}`
        );

      }


      // ------------------------------------------------
      // Extract message content
      // ------------------------------------------------

      const content =
        result?.choices?.[0]?.message?.content;


      console.log(
        "Sarvam raw content:",
        content
      );


      if (!content) {

        throw new Error(
          "Sarvam returned empty content"
        );

      }


      // ------------------------------------------------
      // Parse knowledge JSON
      // ------------------------------------------------

      const parsed =
        parseSarvamJSON(
          content
        );


      console.log(
        "Sarvam parsed response:",
        JSON.stringify(parsed)
      );


      if (
        !parsed ||
        !Array.isArray(
          parsed.knowledge
        )
      ) {

        throw new Error(
          "Invalid Sarvam response format: knowledge array missing"
        );

      }


      console.log(
        `Knowledge items received: ${parsed.knowledge.length}`
      );


      return parsed.knowledge;

    } catch (error) {

      lastError = error;


      console.error(
        `Sarvam attempt ${attempt + 1} failed:`,
        error
      );


      if (
        attempt <
        SARVAM_MAX_RETRIES
      ) {

        await sleep(
          1000 *
          (attempt + 1)
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


  // --------------------------------------------------
  // Remove Markdown code fences
  // --------------------------------------------------

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


  // --------------------------------------------------
  // Direct JSON parse
  // --------------------------------------------------

  try {

    return JSON.parse(text);

  } catch {}


  // --------------------------------------------------
  // Find first JSON object
  // --------------------------------------------------

  const start =
    text.indexOf("{");


  const end =
    text.lastIndexOf("}");


  if (
    start !== -1 &&
    end !== -1 &&
    end > start
  ) {

    const jsonText =
      text.slice(
        start,
        end + 1
      );


    try {

      return JSON.parse(
        jsonText
      );

    } catch (error) {

      throw new Error(
        `Could not parse Sarvam JSON: ${error.message}`
      );

    }

  }


  throw new Error(
    "Could not find JSON object in Sarvam response"
  );

}


// ======================================================
// SAVE / MERGE BUSINESS KNOWLEDGE
//
// IMPORTANT:
// This version DOES NOT use:
// on_conflict=application_id,field
//
// Therefore it does not require a UNIQUE constraint.
// ======================================================

async function saveKnowledge(
  applicationId,
  field,
  newValue,
  sourceUrl,
  env
) {

  console.log(
    `Saving knowledge: ${applicationId} / ${field}`
  );


  // --------------------------------------------------
  // Find existing knowledge row
  // --------------------------------------------------

  const existingUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}` +
    `&select=id,data,source_urls` +
    `&limit=1`;


  const existingResponse =
    await fetch(
      existingUrl,
      {
        method: "GET",

        headers:
          supabaseHeaders(env)
      }
    );


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
    existingRows?.[0] ||
    null;


  // --------------------------------------------------
  // Merge data
  // --------------------------------------------------

  let mergedData =
    newValue;


  if (
    existing?.data !== undefined
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

  const existingSources =
    Array.isArray(
      existing?.source_urls
    )
      ? existing.source_urls
      : [];


  const sourceUrls = [
    ...new Set(
      [
        ...existingSources,

        ...(sourceUrl
          ? [sourceUrl]
          : [])
      ]
        .filter(Boolean)
    )
  ];


  // --------------------------------------------------
  // UPDATE existing row
  // --------------------------------------------------

  if (existing?.id) {

    console.log(
      `Updating existing knowledge row: ${existing.id}`
    );


    const updateUrl =
      `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
      `?id=eq.${encodeURIComponent(existing.id)}`;


    const response =
      await fetch(
        updateUrl,
        {
          method: "PATCH",

          headers: {
            ...supabaseHeaders(env),

            "Prefer":
              "return=representation"
          },

          body:
            JSON.stringify({

              data:
                mergedData,

              source_urls:
                sourceUrls,

              updated_at:
                new Date().toISOString()

            })
        }
      );


    if (!response.ok) {

      const text =
        await response.text();


      throw new Error(
        `Failed to update business knowledge: ${response.status} ${text}`
      );

    }


    const saved =
      await response.json();


    console.log(
      "Updated knowledge successfully:",
      JSON.stringify(saved)
    );


    return;

  }


  // --------------------------------------------------
  // INSERT new row
  // --------------------------------------------------

  console.log(
    `Creating new knowledge row: ${applicationId} / ${field}`
  );


  const insertUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge`;


  const response =
    await fetch(
      insertUrl,
      {
        method: "POST",

        headers: {
          ...supabaseHeaders(env),

          "Prefer":
            "return=representation"
        },

        body:
          JSON.stringify({

            application_id:
              applicationId,

            field:
              field,

            data:
              mergedData,

            source_urls:
              sourceUrls,

            created_at:
              new Date().toISOString(),

            updated_at:
              new Date().toISOString()

          })
      }
    );


  if (!response.ok) {

    const text =
      await response.text();


    throw new Error(
      `Failed to insert business knowledge: ${response.status} ${text}`
    );

  }


  const saved =
    await response.json();


  console.log(
    "Created knowledge successfully:",
    JSON.stringify(saved)
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
  // Different primitive values
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
      typeof item === "object"
        ? JSON.stringify(item)
        : String(item);


    if (
      !seen.has(key)
    ) {

      seen.add(key);

      result.push(item);

    }

  }


  return result;

}


// ======================================================
// OBJECT CHECK
// ======================================================

function isObject(
  value
) {

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

    ai_status:
      status,

    updated_at:
      new Date().toISOString()

  };


  // --------------------------------------------------
  // Successful processing
  // --------------------------------------------------

  if (
    status === "completed"
  ) {

    body.ai_error = null;

  }


  // --------------------------------------------------
  // Failed processing
  // --------------------------------------------------

  if (
    status === "failed"
  ) {

    body.ai_error =
      String(
        errorMessage ||
        "Unknown processing error"
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
      `Failed to update status: ${response.status} ${text}`
    );

  }


  console.log(
    `business_data ${id} → ${status}`
  );

}


// ======================================================
// SUPABASE HEADERS
// ======================================================

function supabaseHeaders(
  env
) {

  if (
    !env.SUPABASE_SERVICE_ROLE_KEY
  ) {

    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY secret is missing"
    );

  }


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

function sleep(
  ms
) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );

          }
