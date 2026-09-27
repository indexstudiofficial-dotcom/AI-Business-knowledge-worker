// ============================================================
// AI BUSINESS KNOWLEDGE WORKER
// ============================================================
//
// FLOW:
//
// business_data INSERT
//        ↓
// Supabase Database Webhook
//        ↓
// Cloudflare Worker
//        ↓
// Read business_data.data
//        ↓
// Sarvam AI
//        ↓
// Save extracted fields to business_knowledge
//        ↓
// Mark business_data.ai_status = completed
//
// IMPORTANT:
// This Worker DOES NOT use Cloudflare Queues.
// ============================================================


// ============================================================
// CONFIG
// ============================================================

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL =
  "sarvam-105b";

const MAX_TEXT_CHARS =
  100000;


// ============================================================
// WORKER ENTRY
// ============================================================

export default {

  async fetch(request, env, ctx) {

    console.log("====================================");
    console.log("[WORKER] Request received");
    console.log("====================================");


    // --------------------------------------------------------
    // OPTIONS
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {

      return json({
        success: true
      });

    }


    // --------------------------------------------------------
    // ONLY POST
    // --------------------------------------------------------

    if (request.method !== "POST") {

      return json(
        {
          success: false,
          error: "Only POST requests are allowed"
        },
        405
      );

    }


    // --------------------------------------------------------
    // CHECK SECRETS
    // --------------------------------------------------------

    console.log("[1] Checking secrets...");

    if (!env.SUPABASE_URL) {

      console.error(
        "[ERROR] SUPABASE_URL missing"
      );

      return json(
        {
          success: false,
          error: "SUPABASE_URL missing"
        },
        500
      );

    }


    if (!env.SUPABASE_SERVICE_ROLE_KEY) {

      console.error(
        "[ERROR] SUPABASE_SERVICE_ROLE_KEY missing"
      );

      return json(
        {
          success: false,
          error:
            "SUPABASE_SERVICE_ROLE_KEY missing"
        },
        500
      );

    }


    if (!env.SARVAM_API_KEY) {

      console.error(
        "[ERROR] SARVAM_API_KEY missing"
      );

      return json(
        {
          success: false,
          error: "SARVAM_API_KEY missing"
        },
        500
      );

    }


    console.log("[1] Secrets OK");


    // --------------------------------------------------------
    // READ WEBHOOK
    // --------------------------------------------------------

    let payload;

    try {

      payload =
        await request.json();

    } catch (error) {

      console.error(
        "[ERROR] Invalid JSON"
      );

      return json(
        {
          success: false,
          error: "Invalid JSON"
        },
        400
      );

    }


    console.log(
      "[2] Webhook type:",
      payload?.type
    );

    console.log(
      "[2] Webhook table:",
      payload?.table
    );


    // --------------------------------------------------------
    // GET RECORD
    // --------------------------------------------------------

    const record =
      payload?.record;


    if (!record) {

      console.error(
        "[ERROR] record missing"
      );

      return json(
        {
          success: false,
          error: "record missing"
        },
        400
      );

    }


    console.log(
      "[3] business_data ID:",
      record.id
    );

    console.log(
      "[3] application_id:",
      record.application_id
    );

    console.log(
      "[3] field:",
      record.field
    );

    console.log(
      "[3] ai_status:",
      record.ai_status
    );


    // --------------------------------------------------------
    // VALIDATE TABLE
    // --------------------------------------------------------

    if (
      payload.table &&
      payload.table !== "business_data"
    ) {

      console.log(
        "[SKIP] Wrong table"
      );

      return json({
        success: true,
        skipped: true
      });

    }


    // --------------------------------------------------------
    // VALIDATE EVENT
    // --------------------------------------------------------

    if (
      payload.type &&
      payload.type !== "INSERT"
    ) {

      console.log(
        "[SKIP] Not INSERT"
      );

      return json({
        success: true,
        skipped: true
      });

    }


    // --------------------------------------------------------
    // VALIDATE FIELD
    // --------------------------------------------------------

    if (record.field !== "page") {

      console.log(
        "[SKIP] field is not page"
      );

      return json({
        success: true,
        skipped: true,
        reason: "field is not page"
      });

    }


    // --------------------------------------------------------
    // VALIDATE STATUS
    // --------------------------------------------------------

    if (
      record.ai_status &&
      record.ai_status !== "pending"
    ) {

      console.log(
        "[SKIP] ai_status:",
        record.ai_status
      );

      return json({
        success: true,
        skipped: true,
        reason:
          `ai_status is ${record.ai_status}`
      });

    }


    // --------------------------------------------------------
    // VALIDATE IDs
    // --------------------------------------------------------

    if (!record.id) {

      return json(
        {
          success: false,
          error: "business_data.id missing"
        },
        400
      );

    }


    if (!record.application_id) {

      return json(
        {
          success: false,
          error:
            "application_id missing"
        },
        400
      );

    }


    // --------------------------------------------------------
    // PROCESS
    // --------------------------------------------------------
    //
    // We deliberately process directly here.
    //
    // NO QUEUE.
    //
    // This makes debugging much easier.
    // --------------------------------------------------------

    try {

      const result =
        await processBusinessData(
          record,
          env
        );


      console.log(
        "[SUCCESS] Processing finished"
      );


      return json({
        success: true,
        processed: true,
        business_data_id: record.id,
        application_id:
          record.application_id,
        saved_fields:
          result.savedFields
      });

    } catch (error) {

      console.error(
        "===================================="
      );

      console.error(
        "[PROCESS FAILED]"
      );

      console.error(
        error?.stack ||
        error?.message ||
        error
      );

      console.error(
        "===================================="
      );


      // ------------------------------------------------------
      // Try marking row as failed
      // ------------------------------------------------------

      try {

        await updateStatus(
          record.id,
          "failed",
          env
        );

      } catch (statusError) {

        console.error(
          "[ERROR] Could not mark failed:",
          statusError
        );

      }


      return json(
        {
          success: false,
          processed: false,
          error:
            error?.message ||
            String(error)
        },
        500
      );

    }

  }

};


// ============================================================
// MAIN PROCESS
// ============================================================

async function processBusinessData(
  record,
  env
) {

  console.log("");
  console.log(
    "========== PROCESS START =========="
  );


  // ----------------------------------------------------------
  // 1. Mark processing
  // ----------------------------------------------------------

  console.log(
    "[4] Setting ai_status = processing"
  );


  await updateStatus(
    record.id,
    "processing",
    env
  );


  // ----------------------------------------------------------
  // 2. Extract raw website text
  // ----------------------------------------------------------

  console.log(
    "[5] Reading business_data.data"
  );


  const rawText =
    extractText(record.data);


  if (
    !rawText ||
    rawText.trim().length === 0
  ) {

    throw new Error(
      "business_data.data is empty"
    );

  }


  console.log(
    "[5] Raw text characters:",
    rawText.length
  );


  // ----------------------------------------------------------
  // 3. Limit text
  // ----------------------------------------------------------

  const text =
    rawText.length > MAX_TEXT_CHARS
      ? rawText.slice(0, MAX_TEXT_CHARS)
      : rawText;


  console.log(
    "[6] Text sent to Sarvam:",
    text.length
  );


  // ----------------------------------------------------------
  // 4. Sarvam
  // ----------------------------------------------------------

  console.log(
    "[7] Calling Sarvam..."
  );


  const extracted =
    await callSarvam(
      text,
      env
    );


  console.log(
    "[7] Sarvam returned successfully"
  );


  console.log(
    "[8] Extracted fields:",
    Object.keys(extracted)
  );


  // ----------------------------------------------------------
  // 5. Save each field
  // ----------------------------------------------------------

  let savedFields = 0;


  for (
    const [field, value]
    of Object.entries(extracted)
  ) {

    if (
      isEmpty(value)
    ) {

      continue;

    }


    const normalizedField =
      normalizeField(field);


    console.log(
      `[9] Saving ${normalizedField}`
    );


    await saveKnowledge(
      record.application_id,
      normalizedField,
      value,
      env
    );


    savedFields++;

  }


  // ----------------------------------------------------------
  // 6. Mark completed
  // ----------------------------------------------------------

  await updateStatus(
    record.id,
    "completed",
    env
  );


  console.log(
    "[10] ai_status = completed"
  );


  console.log(
    "========== PROCESS END =========="
  );


  return {
    savedFields
  };

}


// ============================================================
// SARVAM
// ============================================================

async function callSarvam(
  rawText,
  env
) {

  const systemPrompt = `
You extract real business information from scraped website text.

Return ONLY valid JSON.

RULES:

- Never invent information.
- Never guess.
- Only extract information explicitly supported by the text.
- Ignore Lorem ipsum.
- Ignore demo content.
- Ignore template content.
- Ignore placeholder emails.
- Ignore placeholder phone numbers.
- Ignore example.com, website.com and similar demo values.
- Ignore fake/template business information.
- Remove duplicate information.
- Do not include empty fields.
- Services should be an array.
- Products should be an array.
- Social media should be an object when possible.
- Hours should be an object when possible.

Possible fields:

business_name
business_type
business_profile
description
about
services
products
phone
email
address
hours
team
appointments
pricing
social_media
faqs
contact

Only return fields that actually exist in the supplied text.
`;


  const userPrompt = `
Extract the real business information from this scraped website text.

SCRAPED WEBSITE TEXT:

----------------------------

${rawText}

----------------------------

Return ONLY JSON.
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

        body:
          JSON.stringify({

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

            response_format: {
              type: "json_object"
            },

            temperature: 0.2,

            max_tokens: 4096

          })

      }
    );


  const responseText =
    await response.text();


  console.log(
    "[SARVAM] Status:",
    response.status
  );


  // ----------------------------------------------------------
  // API error
  // ----------------------------------------------------------

  if (!response.ok) {

    console.error(
      "[SARVAM ERROR]",
      responseText
    );


    throw new Error(
      `Sarvam API error ${response.status}: ${responseText}`
    );

  }


  // ----------------------------------------------------------
  // Parse API response
  // ----------------------------------------------------------

  let apiData;


  try {

    apiData =
      JSON.parse(responseText);

  } catch {

    throw new Error(
      "Sarvam returned invalid API JSON"
    );

  }


  // ----------------------------------------------------------
  // Get model content
  // ----------------------------------------------------------

  const content =
    apiData
      ?.choices
      ?.at(0)
      ?.message
      ?.content;


  if (!content) {

    console.error(
      "[SARVAM] Full response:",
      JSON.stringify(apiData)
    );


    throw new Error(
      "Sarvam returned no message content"
    );

  }


  console.log(
    "[SARVAM] Content received"
  );


  // ----------------------------------------------------------
  // Parse model JSON
  // ----------------------------------------------------------

  let result;


  try {

    result =
      typeof content === "string"
        ? JSON.parse(
            cleanJsonString(content)
          )
        : content;

  } catch (error) {

    console.error(
      "[SARVAM JSON ERROR]",
      content
    );


    throw new Error(
      "Sarvam model response was not valid JSON"
    );

  }


  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {

    throw new Error(
      "Sarvam returned an invalid object"
    );

  }


  return cleanObject(result);

}


// ============================================================
// CLEAN JSON STRING
// ============================================================

function cleanJsonString(text) {

  let value =
    String(text).trim();


  // Remove ```json
  if (
    value.startsWith("```")
  ) {

    value =
      value.replace(
        /^```(?:json)?/i,
        ""
      );

    value =
      value.replace(
        /```$/i,
        ""
      );

  }


  return value.trim();

}


// ============================================================
// CLEAN OBJECT
// ============================================================

function cleanObject(object) {

  const result = {};


  for (
    const [key, value]
    of Object.entries(object)
  ) {

    const field =
      normalizeField(key);


    const cleaned =
      cleanValue(value);


    if (
      !isEmpty(cleaned)
    ) {

      result[field] =
        cleaned;

    }

  }


  return result;

}


// ============================================================
// CLEAN VALUE
// ============================================================

function cleanValue(value) {

  if (
    typeof value === "string"
  ) {

    return value.trim();

  }


  if (
    Array.isArray(value)
  ) {

    const cleaned =
      value
        .map(
          item =>
            cleanValue(item)
        )
        .filter(
          item =>
            !isEmpty(item)
        );


    return uniqueArray(cleaned);

  }


  if (
    value &&
    typeof value === "object"
  ) {

    const object = {};


    for (
      const [key, item]
      of Object.entries(value)
    ) {

      const cleaned =
        cleanValue(item);


      if (
        !isEmpty(cleaned)
      ) {

        object[key] =
          cleaned;

      }

    }


    return object;

  }


  return value;

}


// ============================================================
// NORMALIZE FIELD
// ============================================================

function normalizeField(field) {

  return String(field)
    .trim()
    .toLowerCase()
    .replace(
      /[^a-z0-9_]+/g,
      "_"
    )
    .replace(
      /^_+|_+$/g,
      ""
    )
    .slice(0, 100);

}


// ============================================================
// REMOVE DUPLICATES
// ============================================================

function uniqueArray(array) {

  const seen =
    new Set();

  const result = [];


  for (
    const item of array
  ) {

    let key;


    try {

      key =
        JSON.stringify(item);

    } catch {

      key =
        String(item);

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
// EMPTY CHECK
// ============================================================

function isEmpty(value) {

  if (
    value === null ||
    value === undefined
  ) {

    return true;

  }


  if (
    typeof value === "string" &&
    value.trim() === ""
  ) {

    return true;

  }


  if (
    Array.isArray(value) &&
    value.length === 0
  ) {

    return true;

  }


  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {

    return true;

  }


  return false;

}


// ============================================================
// EXTRACT RAW TEXT
// ============================================================

function extractText(data) {

  if (
    typeof data === "string"
  ) {

    return data;

  }


  if (
    data &&
    typeof data === "object"
  ) {

    if (
      typeof data.text === "string"
    ) {

      return data.text;

    }


    return JSON.stringify(data);

  }


  return String(
    data ?? ""
  );

}


// ============================================================
// SAVE TO business_knowledge
// ============================================================

async function saveKnowledge(
  applicationId,
  field,
  value,
  env
) {

  // ----------------------------------------------------------
  // Check existing row
  // ----------------------------------------------------------

  const selectUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}` +
    `&select=id,data`;


  const existingResponse =
    await fetch(
      selectUrl,
      {
        method: "GET",
        headers:
          supabaseHeaders(env)
      }
    );


  const existingText =
    await existingResponse.text();


  if (
    !existingResponse.ok
  ) {

    throw new Error(
      `Could not read business_knowledge: ${existingResponse.status} ${existingText}`
    );

  }


  let existing = [];


  try {

    existing =
      JSON.parse(
        existingText
      );

  } catch {

    existing = [];

  }


  // ----------------------------------------------------------
  // Merge existing value
  // ----------------------------------------------------------

  let finalValue =
    value;


  if (
    existing.length > 0
  ) {

    console.log(
      `[KNOWLEDGE] Updating existing field: ${field}`
    );


    finalValue =
      mergeValues(
        existing[0].data,
        value
      );

  } else {

    console.log(
      `[KNOWLEDGE] Creating field: ${field}`
    );

  }


  // ----------------------------------------------------------
  // Upsert
  // ----------------------------------------------------------

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
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

        body:
          JSON.stringify({

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


  const responseText =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      `Could not save business_knowledge: ${response.status} ${responseText}`
    );

  }


  console.log(
    `[KNOWLEDGE] Saved: ${field}`
  );

}


// ============================================================
// MERGE VALUES
// ============================================================

function mergeValues(
  oldValue,
  newValue
) {

  // Array + array
  if (
    Array.isArray(oldValue) &&
    Array.isArray(newValue)
  ) {

    return uniqueArray([
      ...oldValue,
      ...newValue
    ]);

  }


  // Object + object
  if (
    oldValue &&
    typeof oldValue === "object" &&
    !Array.isArray(oldValue) &&

    newValue &&
    typeof newValue === "object" &&
    !Array.isArray(newValue)
  ) {

    return {
      ...oldValue,
      ...newValue
    };

  }


  // Scalar
  return newValue;

}


// ============================================================
// UPDATE business_data STATUS
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

        body:
          JSON.stringify({

            ai_status:
              status,

            updated_at:
              new Date().toISOString()

          })
      }
    );


  const responseText =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      `Could not update business_data: ${response.status} ${responseText}`
    );

  }


  console.log(
    `[DATABASE] ai_status = ${status}`
  );

}


// ============================================================
// SUPABASE HEADERS
// ============================================================

function supabaseHeaders(env) {

  return {

    "Content-Type":
      "application/json",

    "apikey":
      env.SUPABASE_SERVICE_ROLE_KEY,

    "Authorization":
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

    "Accept":
      "application/json"

  };

}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(
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
        "Content-Type":
          "application/json",

        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Methods":
          "POST, OPTIONS",

        "Access-Control-Allow-Headers":
          "Content-Type"
      }
    }
  );

      }
