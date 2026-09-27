// ============================================================
// AI BUSINESS KNOWLEDGE WORKER
// ============================================================

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL =
  "sarvam-105b";

const MAX_TEXT_CHARS = 100000;


// ============================================================
// WORKER
// ============================================================

export default {

  // ==========================================================
  // HTTP REQUEST
  // ==========================================================

  async fetch(request, env) {

    console.log("[WORKER] HTTP request received");
    console.log("[WORKER] Method:", request.method);
    console.log("[WORKER] URL:", request.url);

    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // --------------------------------------------------------
    // Browser GET test
    // --------------------------------------------------------

    if (request.method === "GET") {

      return jsonResponse({
        success: true,
        message: "AI Business Knowledge Worker is alive",
        worker: "ai-business-knowledge-worker",
        expected_method: "POST"
      });
    }

    // --------------------------------------------------------
    // Only POST is allowed for webhook
    // --------------------------------------------------------

    if (request.method !== "POST") {

      return jsonResponse(
        {
          success: false,
          error: "Only POST requests are allowed"
        },
        405
      );
    }

    try {

      // ======================================================
      // 1. CHECK ENVIRONMENT VARIABLES
      // ======================================================

      console.log("[1] Checking environment variables...");

      if (!env.SUPABASE_URL) {
        throw new Error(
          "SUPABASE_URL is missing"
        );
      }

      if (!env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error(
          "SUPABASE_SERVICE_ROLE_KEY is missing"
        );
      }

      if (!env.SARVAM_API_KEY) {
        throw new Error(
          "SARVAM_API_KEY is missing"
        );
      }


      // ======================================================
      // 2. READ WEBHOOK BODY
      // ======================================================

      const rawBody = await request.text();

      console.log(
        "[2] Webhook body length:",
        rawBody.length
      );

      console.log(
        "[2] Webhook body:",
        rawBody
      );

      if (!rawBody) {
        throw new Error(
          "Webhook body is empty"
        );
      }

      let payload;

      try {

        payload = JSON.parse(rawBody);

      } catch (error) {

        console.error(
          "[2] Invalid JSON:",
          rawBody
        );

        throw new Error(
          "Webhook body is not valid JSON"
        );
      }


      // ======================================================
      // 3. SHOW WEBHOOK STRUCTURE
      // ======================================================

      console.log(
        "[3] Payload keys:",
        Object.keys(payload || {})
      );

      console.log(
        "[3] Payload:",
        JSON.stringify(payload)
      );


      // ======================================================
      // 4. FIND BUSINESS_DATA RECORD
      // ======================================================

      // Supabase normally sends:
      //
      // {
      //   "type": "INSERT",
      //   "table": "business_data",
      //   "schema": "public",
      //   "record": {...},
      //   "old_record": null
      // }
      //
      // But we support several possible structures.

      const record =
        payload?.record ||
        payload?.new_record ||
        payload?.data?.record ||
        payload?.data?.new_record ||
        payload?.data;


      // ------------------------------------------------------
      // If record is still missing
      // ------------------------------------------------------

      if (!record) {

        console.error(
          "[4] RECORD NOT FOUND"
        );

        throw new Error(
          "Could not find business_data record in webhook payload"
        );
      }


      console.log(
        "[4] Record found:",
        JSON.stringify(record)
      );


      // ======================================================
      // 5. CHECK EVENT TYPE
      // ======================================================

      const eventType =
        payload?.type ||
        payload?.event ||
        payload?.operation;

      console.log(
        "[5] Event type:",
        eventType || "not provided"
      );


      // If Supabase sends the normal INSERT event,
      // process it.

      if (
        eventType &&
        eventType !== "INSERT" &&
        eventType !== "insert"
      ) {

        console.log(
          "[5] Ignoring non-INSERT event"
        );

        return jsonResponse({
          success: true,
          skipped: true,
          reason: "Not an INSERT event"
        });
      }


      // ======================================================
      // 6. CHECK TABLE
      // ======================================================

      const tableName =
        payload?.table ||
        payload?.table_name;

      console.log(
        "[6] Table:",
        tableName || "not provided"
      );

      if (
        tableName &&
        tableName !== "business_data"
      ) {

        return jsonResponse({
          success: true,
          skipped: true,
          reason: "Not business_data table"
        });
      }


      // ======================================================
      // 7. SHOW RECORD INFORMATION
      // ======================================================

      console.log(
        "[7] business_data ID:",
        record.id
      );

      console.log(
        "[7] application_id:",
        record.application_id
      );

      console.log(
        "[7] field:",
        record.field
      );

      console.log(
        "[7] ai_status:",
        record.ai_status
      );


      // ======================================================
      // 8. VALIDATE FIELD
      // ======================================================

      if (record.field !== "page") {

        console.log(
          "[8] Ignoring field:",
          record.field
        );

        return jsonResponse({
          success: true,
          skipped: true,
          reason: "Only field=page is processed"
        });
      }


      // ======================================================
      // 9. VALIDATE STATUS
      // ======================================================

      if (
        record.ai_status &&
        record.ai_status !== "pending"
      ) {

        console.log(
          "[9] Ignoring status:",
          record.ai_status
        );

        return jsonResponse({
          success: true,
          skipped: true,
          reason:
            `ai_status is ${record.ai_status}`
        });
      }


      // ======================================================
      // 10. PROCESS
      // ======================================================

      console.log(
        "[10] Starting business data processing..."
      );

      await processBusinessData(
        record,
        env
      );


      // ======================================================
      // SUCCESS
      // ======================================================

      console.log(
        "[WORKER] Processing completed successfully"
      );

      return jsonResponse({
        success: true,
        processed: true,
        business_data_id: record.id,
        application_id:
          record.application_id
      });

    } catch (error) {

      console.error(
        "[WORKER] ERROR:",
        error
      );

      return jsonResponse(
        {
          success: false,
          error:
            error?.message ||
            String(error)
        },
        400
      );
    }
  },


  // ==========================================================
  // OLD QUEUE HANDLER
  // ==========================================================

  async queue(batch) {

    console.log(
      `[QUEUE] Received ${batch.messages.length} old queue message(s)`
    );

    for (const message of batch.messages) {

      console.log(
        "[QUEUE] Ignoring old queue message"
      );

      message.ack();
    }

    console.log(
      "[QUEUE] Old queue messages acknowledged"
    );
  }
};


// ============================================================
// PROCESS BUSINESS DATA
// ============================================================

async function processBusinessData(
  record,
  env
) {

  console.log(
    "[PROCESS] Setting ai_status = processing"
  );

  await updateStatus(
    record.id,
    "processing",
    env
  );


  try {

    // ========================================================
    // READ RAW TEXT
    // ========================================================

    console.log(
      "[PROCESS] Reading business_data.data"
    );

    let rawText = "";


    if (
      typeof record.data === "string"
    ) {

      rawText = record.data;

    } else if (
      record.data &&
      typeof record.data === "object"
    ) {

      // JSONB string becomes a string,
      // but this handles objects too.

      rawText =
        JSON.stringify(record.data);

    } else {

      throw new Error(
        "business_data.data is empty"
      );
    }


    rawText = rawText.trim();


    if (!rawText) {

      throw new Error(
        "business_data.data contains no text"
      );
    }


    // ========================================================
    // LIMIT TEXT SIZE
    // ========================================================

    if (
      rawText.length >
      MAX_TEXT_CHARS
    ) {

      rawText =
        rawText.substring(
          0,
          MAX_TEXT_CHARS
        );
    }


    console.log(
      "[PROCESS] Text length:",
      rawText.length
    );


    // ========================================================
    // CALL SARVAM
    // ========================================================

    console.log(
      "[PROCESS] Calling Sarvam..."
    );

    const extractedData =
      await callSarvam(
        rawText,
        record.source_url || "",
        env
      );


    console.log(
      "[PROCESS] Sarvam completed"
    );

    console.log(
      "[PROCESS] Extracted fields:",
      Object.keys(extractedData)
    );


    // ========================================================
    // SAVE EACH FIELD
    // ========================================================

    for (
      const [field, value]
      of Object.entries(extractedData)
    ) {

      if (
        value === null ||
        value === undefined ||
        value === ""
      ) {

        continue;
      }


      console.log(
        "[PROCESS] Saving field:",
        field
      );


      await saveKnowledge(
        record.application_id,
        field,
        value,
        env
      );
    }


    // ========================================================
    // COMPLETED
    // ========================================================

    console.log(
      "[PROCESS] Setting ai_status = completed"
    );

    await updateStatus(
      record.id,
      "completed",
      env
    );


    console.log(
      "[PROCESS] DONE"
    );

  } catch (error) {

    console.error(
      "[PROCESS] ERROR:",
      error
    );


    try {

      await updateStatus(
        record.id,
        "failed",
        env
      );

    } catch (statusError) {

      console.error(
        "[PROCESS] Could not set failed status:",
        statusError
      );
    }


    throw error;
  }
}


// ============================================================
// SARVAM
// ============================================================

async function callSarvam(
  rawText,
  sourceUrl,
  env
) {

  const systemPrompt = `
You are a business information extraction AI.

You receive RAW TEXT scraped from a business website.

Extract ONLY information that is actually supported by the text.

RULES:

- Do not hallucinate.
- Do not invent information.
- Ignore navigation menus.
- Ignore footer templates.
- Ignore placeholder/demo information.
- Ignore fake/template phone numbers.
- Ignore fake/template emails.
- Ignore Lorem Ipsum.
- Ignore generic website template content.
- Ignore information belonging to another business.
- Only extract information that belongs to the real business.
- Do not include uncertain information.
- Do not include empty fields.
- Return ONLY valid JSON.

Useful fields:

business_name
business_type
description
about
services
products
phone
email
address
city
state
country
postal_code
hours
team
owner
doctor
pricing
appointments
faqs
social_media
website
contact_information

For lists, use JSON arrays.

For structured information, use JSON objects.

Example:

{
  "business_name": "Example Dental Clinic",
  "business_type": "Dental Clinic",
  "services": [
    "Root Canal Treatment",
    "Tooth Extraction",
    "Braces"
  ],
  "phone": "+91 79947 43699",
  "address": {
    "street": "18/373 Akshaya Complex",
    "city": "Palakkad",
    "state": "Kerala",
    "country": "India"
  }
}

Only return information supported by the supplied text.
`;


  const userPrompt = `
SOURCE URL:

${sourceUrl || "Unknown"}


RAW WEBSITE TEXT:

${rawText}
`;


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

          model:
            SARVAM_MODEL,

          messages: [
            {
              role: "system",
              content:
                systemPrompt
            },

            {
              role: "user",
              content:
                userPrompt
            }
          ],

          temperature: 0.2,

          max_tokens: 4096,

          response_format: {
            type: "json_object"
          }
        })
      }
    );


  console.log(
    "[SARVAM] HTTP status:",
    response.status
  );


  const responseText =
    await response.text();


  if (!response.ok) {

    console.error(
      "[SARVAM] Error:",
      responseText
    );

    throw new Error(
      `Sarvam API failed with HTTP ${response.status}`
    );
  }


  let responseJson;


  try {

    responseJson =
      JSON.parse(responseText);

  } catch {

    throw new Error(
      "Sarvam returned invalid JSON"
    );
  }


  let content =
    responseJson
      ?.choices?.[0]
      ?.message?.content;


  if (!content) {

    throw new Error(
      "Sarvam response does not contain message content"
    );
  }


  if (
    typeof content === "object"
  ) {

    return cleanExtractedObject(
      content
    );
  }


  content =
    content
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


  let extracted;


  try {

    extracted =
      JSON.parse(content);

  } catch {

    console.error(
      "[SARVAM] Invalid model JSON:",
      content
    );

    throw new Error(
      "Sarvam returned JSON that could not be parsed"
    );
  }


  return cleanExtractedObject(
    extracted
  );
}


// ============================================================
// CLEAN AI OUTPUT
// ============================================================

function cleanExtractedObject(
  value
) {

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {

    throw new Error(
      "AI returned invalid extraction object"
    );
  }


  const result = {};


  for (
    const [rawKey, rawValue]
    of Object.entries(value)
  ) {

    if (!rawKey) {
      continue;
    }


    const field =
      rawKey
        .trim()
        .toLowerCase()
        .replace(
          /\s+/g,
          "_"
        );


    if (!field) {
      continue;
    }


    if (
      rawValue === null ||
      rawValue === undefined ||
      rawValue === ""
    ) {

      continue;
    }


    if (
      Array.isArray(rawValue)
    ) {

      const cleaned =
        rawValue.filter(
          item =>
            item !== null &&
            item !== undefined &&
            item !== ""
        );


      if (
        cleaned.length === 0
      ) {

        continue;
      }


      result[field] =
        cleaned;

      continue;
    }


    result[field] =
      rawValue;
  }


  return result;
}


// ============================================================
// SAVE BUSINESS KNOWLEDGE
// ============================================================

async function saveKnowledge(
  applicationId,
  field,
  value,
  env
) {

  console.log(
    `[KNOWLEDGE] Checking existing field: ${field}`
  );


  const existingUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}` +
    `&select=id,data` +
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

    const errorText =
      await existingResponse.text();

    throw new Error(
      `Could not check business_knowledge: ${errorText}`
    );
  }


  const existingRows =
    await existingResponse.json();


  let finalValue =
    value;


  // ----------------------------------------------------------
  // MERGE ARRAYS
  // ----------------------------------------------------------

  if (
    existingRows.length > 0 &&
    Array.isArray(
      existingRows[0].data
    ) &&
    Array.isArray(value)
  ) {

    finalValue =
      removeDuplicateValues([
        ...existingRows[0].data,
        ...value
      ]);
  }


  // ----------------------------------------------------------
  // MERGE OBJECTS
  // ----------------------------------------------------------

  else if (
    existingRows.length > 0 &&
    isPlainObject(
      existingRows[0].data
    ) &&
    isPlainObject(value)
  ) {

    finalValue = {
      ...existingRows[0].data,
      ...value
    };
  }


  // ----------------------------------------------------------
  // UPSERT
  // ----------------------------------------------------------

  const upsertUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?on_conflict=application_id,field`;


  const response =
    await fetch(
      upsertUrl,
      {
        method: "POST",

        headers: {
          ...supabaseHeaders(env),

          "Prefer":
            "resolution=merge-duplicates,return=minimal"
        },

        body: JSON.stringify({

          application_id:
            applicationId,

          field:
            field,

          data:
            finalValue,

          updated_at:
            new Date().toISOString()
        })
      }
    );


  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Could not save business_knowledge: ${errorText}`
    );
  }


  console.log(
    `[KNOWLEDGE] Saved: ${field}`
  );
}


// ============================================================
// UPDATE STATUS
// ============================================================

async function updateStatus(
  id,
  status,
  env
) {

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}`;


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

        body: JSON.stringify({

          ai_status:
            status,

          updated_at:
            new Date().toISOString()
        })
      }
    );


  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Could not update ai_status: ${errorText}`
    );
  }


  console.log(
    `[STATUS] ${id} -> ${status}`
  );
}


// ============================================================
// SUPABASE HEADERS
// ============================================================

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


// ============================================================
// REMOVE DUPLICATES
// ============================================================

function removeDuplicateValues(
  array
) {

  const seen =
    new Set();

  const result = [];


  for (
    const item of array
  ) {

    let key;


    if (
      item !== null &&
      typeof item === "object"
    ) {

      key =
        JSON.stringify(item);

    } else {

      key =
        String(item)
          .trim()
          .toLowerCase();
    }


    if (
      !seen.has(key)
    ) {

      seen.add(key);

      result.push(item);
    }
  }


  return result;
}


// ============================================================
// OBJECT CHECK
// ============================================================

function isPlainObject(
  value
) {

  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}


// ============================================================
// JSON RESPONSE
// ============================================================

function jsonResponse(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
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


// ============================================================
// CORS
// ============================================================

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
