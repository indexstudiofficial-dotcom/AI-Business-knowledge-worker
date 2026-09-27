// ============================================================
// AI BUSINESS KNOWLEDGE WORKER
// ============================================================
//
// FLOW:
//
// Supabase business_data INSERT
//          ↓
// Supabase Database Webhook
//          ↓
// Cloudflare Worker
//          ↓
// Sarvam AI
//          ↓
// business_knowledge
//          ↓
// business_data.ai_status = completed
//
// ============================================================

const SARVAM_URL =
  "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL =
  "sarvam-105b";

const MAX_TEXT_CHARS =
  100000;


// ============================================================
// WORKER
// ============================================================

export default {

  // ==========================================================
  // HTTP HANDLER
  // ==========================================================

  async fetch(request, env) {

    console.log("========================================");
    console.log("[WORKER] AI BUSINESS KNOWLEDGE WORKER");
    console.log("[WORKER] Request received");
    console.log("[WORKER] Method:", request.method);
    console.log("[WORKER] URL:", request.url);
    console.log("========================================");


    // ========================================================
    // CORS
    // ========================================================

    if (request.method === "OPTIONS") {

      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });

    }


    // ========================================================
    // HEALTH CHECK
    // ========================================================

    if (request.method === "GET") {

      return jsonResponse({

        success: true,

        worker:
          "ai-business-knowledge-worker",

        status:
          "alive",

        expected_webhook_method:
          "POST"

      });

    }


    // ========================================================
    // ONLY POST
    // ========================================================

    if (request.method !== "POST") {

      return jsonResponse(
        {
          success: false,

          error:
            "Only POST requests are allowed"
        },

        405
      );

    }


    try {

      // ======================================================
      // STEP 1
      // CHECK SECRETS
      // ======================================================

      console.log(
        "[1] Checking environment variables..."
      );


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


      console.log(
        "[1] Environment variables OK"
      );


      // ======================================================
      // STEP 2
      // READ REQUEST BODY
      // ======================================================

      const rawBody =
        await request.text();


      console.log(
        "[2] Request body length:",
        rawBody.length
      );


      console.log(
        "[2] Request body:",
        rawBody
      );


      if (!rawBody) {

        throw new Error(
          "Webhook request body is empty"
        );

      }


      // ======================================================
      // STEP 3
      // PARSE JSON
      // ======================================================

      let payload;


      try {

        payload =
          JSON.parse(rawBody);

      }

      catch (error) {

        console.error(
          "[3] JSON parsing failed"
        );

        throw new Error(
          "Webhook body is not valid JSON"
        );

      }


      console.log(
        "[3] Payload received"
      );


      console.log(
        "[3] Payload keys:",
        Object.keys(payload || {})
      );


      console.log(
        "[3] Full payload:",
        JSON.stringify(payload)
      );


      // ======================================================
      // STEP 4
      // FIND RECORD
      // ======================================================

      //
      // IMPORTANT:
      //
      // Your current Supabase webhook sends the
      // business_data row DIRECTLY:
      //
      // {
      //   "id": "...",
      //   "application_id": "...",
      //   "field": "page",
      //   "data": {...},
      //   "ai_status": "pending"
      // }
      //
      // It does NOT send:
      //
      // {
      //   "record": {...}
      // }
      //
      // Therefore we first detect the direct row.
      //
      // We ALSO support the normal wrapped format.
      //


      let record = null;


      // ======================================================
      // FORMAT 1
      // DIRECT BUSINESS_DATA ROW
      // ======================================================

      if (
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        payload.id &&
        payload.application_id &&
        payload.field
      ) {

        console.log(
          "[4] Direct business_data row detected"
        );


        record =
          payload;

      }


      // ======================================================
      // FORMAT 2
      // STANDARD SUPABASE WEBHOOK
      // ======================================================

      else if (
        payload &&
        payload.record &&
        typeof payload.record === "object"
      ) {

        console.log(
          "[4] payload.record detected"
        );


        record =
          payload.record;

      }


      // ======================================================
      // FORMAT 3
      // new_record
      // ======================================================

      else if (
        payload &&
        payload.new_record &&
        typeof payload.new_record === "object"
      ) {

        console.log(
          "[4] payload.new_record detected"
        );


        record =
          payload.new_record;

      }


      // ======================================================
      // FORMAT 4
      // data.record
      // ======================================================

      else if (
        payload &&
        payload.data &&
        payload.data.record &&
        typeof payload.data.record === "object"
      ) {

        console.log(
          "[4] payload.data.record detected"
        );


        record =
          payload.data.record;

      }


      // ======================================================
      // FORMAT 5
      // data.new_record
      // ======================================================

      else if (
        payload &&
        payload.data &&
        payload.data.new_record &&
        typeof payload.data.new_record === "object"
      ) {

        console.log(
          "[4] payload.data.new_record detected"
        );


        record =
          payload.data.new_record;

      }


      // ======================================================
      // RECORD NOT FOUND
      // ======================================================

      if (!record) {

        console.error(
          "[4] BUSINESS_DATA RECORD NOT FOUND"
        );


        return jsonResponse(
          {
            success: false,

            error:
              "Could not find business_data record in webhook payload",

            received_payload:
              payload

          },

          400
        );

      }


      console.log(
        "[4] Business data record found:"
      );


      console.log(
        JSON.stringify(record)
      );


      // ======================================================
      // STEP 5
      // EVENT TYPE
      // ======================================================

      //
      // Your current webhook sends the row directly and
      // therefore does not include "type".
      //
      // In that situation we assume INSERT.
      //

      const eventType =
        payload?.type ||
        payload?.event ||
        payload?.operation ||
        "INSERT";


      console.log(
        "[5] Event type:",
        eventType
      );


      if (
        String(eventType).toUpperCase() !==
        "INSERT"
      ) {

        console.log(
          "[5] Ignoring non-INSERT event"
        );


        return jsonResponse({

          success: true,

          skipped: true,

          reason:
            "Only INSERT events are processed"

        });

      }


      // ======================================================
      // STEP 6
      // TABLE
      // ======================================================

      //
      // Your direct webhook payload does not contain
      // a table name, so default to business_data.
      //

      const tableName =
        payload?.table ||
        payload?.table_name ||
        "business_data";


      console.log(
        "[6] Table:",
        tableName
      );


      if (
        tableName !==
        "business_data"
      ) {

        return jsonResponse({

          success: true,

          skipped: true,

          reason:
            "Not business_data table"

        });

      }


      // ======================================================
      // STEP 7
      // GET RECORD VALUES
      // ======================================================

      const businessDataId =
        record.id;


      const applicationId =
        record.application_id;


      const field =
        record.field;


      const aiStatus =
        record.ai_status;


      console.log(
        "[7] business_data ID:",
        businessDataId
      );


      console.log(
        "[7] application_id:",
        applicationId
      );


      console.log(
        "[7] field:",
        field
      );


      console.log(
        "[7] ai_status:",
        aiStatus
      );


      // ======================================================
      // VALIDATION
      // ======================================================

      if (!businessDataId) {

        throw new Error(
          "business_data record ID is missing"
        );

      }


      if (!applicationId) {

        throw new Error(
          "application_id is missing"
        );

      }


      if (!field) {

        throw new Error(
          "field is missing"
        );

      }


      // ======================================================
      // STEP 8
      // ONLY PROCESS PAGE
      // ======================================================

      if (
        field !==
        "page"
      ) {

        console.log(
          "[8] Ignoring field:",
          field
        );


        return jsonResponse({

          success: true,

          skipped: true,

          reason:
            "Only field=page is processed"

        });

      }


      // ======================================================
      // STEP 9
      // ONLY PROCESS PENDING
      // ======================================================

      if (
        aiStatus &&
        aiStatus !== "pending"
      ) {

        console.log(
          "[9] Ignoring because ai_status =",
          aiStatus
        );


        return jsonResponse({

          success: true,

          skipped: true,

          reason:
            `ai_status is ${aiStatus}`

        });

      }


      // ======================================================
      // STEP 10
      // PROCESS
      // ======================================================

      console.log(
        "[10] Starting AI processing..."
      );


      await processBusinessData(
        record,
        env
      );


      // ======================================================
      // SUCCESS
      // ======================================================

      console.log(
        "[WORKER] ========================================"
      );

      console.log(
        "[WORKER] PROCESSING COMPLETED"
      );

      console.log(
        "[WORKER] ========================================"
      );


      return jsonResponse({

        success: true,

        processed: true,

        business_data_id:
          businessDataId,

        application_id:
          applicationId

      });


    }

    catch (error) {

      console.error(
        "[WORKER] ========================================"
      );

      console.error(
        "[WORKER] ERROR"
      );

      console.error(
        error
      );

      console.error(
        "[WORKER] ========================================"
      );


      return jsonResponse(

        {
          success: false,

          error:
            error?.message ||
            String(error)

        },

        500

      );

    }

  },


  // ==========================================================
  // OLD CLOUDFLARE QUEUE HANDLER
  // ==========================================================
  //
  // Your Worker still has an old Queue consumer attached.
  //
  // We are NOT using this Queue for the AI workflow.
  //
  // This handler only exists so Cloudflare accepts the Worker.
  //
  // ==========================================================

  async queue(batch) {

    console.log(
      "[QUEUE] Old Queue message received"
    );


    console.log(
      "[QUEUE] Message count:",
      batch.messages.length
    );


    for (
      const message
      of batch.messages
    ) {

      console.log(
        "[QUEUE] Ignoring old message"
      );


      message.ack();

    }


    console.log(
      "[QUEUE] Old messages acknowledged"
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

  const id =
    record.id;


  try {

    // ========================================================
    // STEP A
    // MARK PROCESSING
    // ========================================================

    console.log(
      "[PROCESS A] Setting status = processing"
    );


    await updateStatus(
      id,
      "processing",
      env
    );


    // ========================================================
    // STEP B
    // GET RAW WEBSITE TEXT
    // ========================================================

    console.log(
      "[PROCESS B] Reading business_data.data"
    );


    let rawText;


    if (
      typeof record.data ===
      "string"
    ) {

      rawText =
        record.data;

    }


    else if (
      record.data !== null &&
      record.data !== undefined
    ) {

      rawText =
        JSON.stringify(
          record.data
        );

    }


    else {

      throw new Error(
        "business_data.data is empty"
      );

    }


    rawText =
      rawText.trim();


    if (!rawText) {

      throw new Error(
        "business_data.data contains no text"
      );

    }


    // ========================================================
    // LIMIT TEXT
    // ========================================================

    if (
      rawText.length >
      MAX_TEXT_CHARS
    ) {

      console.log(
        "[PROCESS B] Text too large. Truncating."
      );


      rawText =
        rawText.substring(
          0,
          MAX_TEXT_CHARS
        );

    }


    console.log(
      "[PROCESS B] Text characters:",
      rawText.length
    );


    // ========================================================
    // STEP C
    // CALL SARVAM
    // ========================================================

    console.log(
      "[PROCESS C] Sending data to Sarvam..."
    );


    const extractedData =
      await callSarvam(
        rawText,
        record.source_url ||
          "",
        env
      );


    console.log(
      "[PROCESS C] Sarvam returned successfully"
    );


    console.log(
      "[PROCESS C] Extracted fields:",
      Object.keys(
        extractedData
      )
    );


    // ========================================================
    // STEP D
    // SAVE KNOWLEDGE
    // ========================================================

    const fields =
      Object.entries(
        extractedData
      );


    if (
      fields.length === 0
    ) {

      throw new Error(
        "Sarvam extracted no business information"
      );

    }


    for (
      const [
        field,
        value
      ]
      of fields
    ) {

      if (
        value === null ||
        value === undefined ||
        value === ""
      ) {

        continue;

      }


      console.log(
        `[PROCESS D] Saving field: ${field}`
      );


      await saveKnowledge(
        record.application_id,
        field,
        value,
        env
      );

    }


    // ========================================================
    // STEP E
    // COMPLETED
    // ========================================================

    console.log(
      "[PROCESS E] Setting status = completed"
    );


    await updateStatus(
      id,
      "completed",
      env
    );


    console.log(
      "[PROCESS] SUCCESS"
    );

  }


  catch (error) {

    console.error(
      "[PROCESS] ERROR:",
      error
    );


    // ========================================================
    // MARK FAILED
    // ========================================================

    try {

      await updateStatus(
        id,
        "failed",
        env
      );

    }

    catch (statusError) {

      console.error(
        "[PROCESS] Failed to update status:",
        statusError
      );

    }


    throw error;

  }

}


// ============================================================
// CALL SARVAM
// ============================================================

async function callSarvam(
  rawText,
  sourceUrl,
  env
) {

  const systemPrompt = `
You are a business information extraction AI.

You receive raw text scraped from a business website.

Your job is to extract real business information from that text.

STRICT RULES:

1. Never hallucinate.
2. Never invent information.
3. Only use information explicitly supported by the supplied text.
4. Ignore website navigation.
5. Ignore menus.
6. Ignore footer templates.
7. Ignore generic template content.
8. Ignore demo information.
9. Ignore placeholder information.
10. Ignore Lorem Ipsum.
11. Ignore fake/example phone numbers.
12. Ignore fake/example email addresses.
13. Ignore information that clearly belongs to another business.
14. Do not guess missing information.
15. Do not create information that is not present.
16. Do not include empty fields.
17. Return ONLY valid JSON.
18. Do not return Markdown.
19. Do not return explanations.

Possible fields include:

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

For multiple services/products, use arrays.

For structured information, use objects.

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

Return only information supported by the raw website text.
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

        method:
          "POST",

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
                role:
                  "system",

                content:
                  systemPrompt
              },

              {
                role:
                  "user",

                content:
                  userPrompt
              }

            ],

            temperature:
              0.2,

            max_tokens:
              4096,

            response_format: {
              type:
                "json_object"
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
      "[SARVAM] API error:",
      responseText
    );


    throw new Error(
      `Sarvam API failed with HTTP ${response.status}: ${responseText}`
    );

  }


  let responseJson;


  try {

    responseJson =
      JSON.parse(
        responseText
      );

  }

  catch {

    console.error(
      "[SARVAM] Invalid API JSON:",
      responseText
    );


    throw new Error(
      "Sarvam returned invalid JSON"
    );

  }


  let content =
    responseJson
      ?.choices?.[0]
      ?.message?.content;


  if (!content) {

    console.error(
      "[SARVAM] Full response:",
      responseText
    );


    throw new Error(
      "Sarvam response does not contain message content"
    );

  }


  // ========================================================
  // CONTENT MAY ALREADY BE OBJECT
  // ========================================================

  if (
    typeof content ===
    "object"
  ) {

    return cleanExtractedObject(
      content
    );

  }


  // ========================================================
  // REMOVE MARKDOWN JSON FENCES
  // ========================================================

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


  // ========================================================
  // PARSE JSON
  // ========================================================

  let extracted;


  try {

    extracted =
      JSON.parse(
        content
      );

  }

  catch {

    console.error(
      "[SARVAM] Model returned invalid JSON:"
    );


    console.error(
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
// CLEAN SARVAM OUTPUT
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
      "Sarvam returned an invalid extraction object"
    );

  }


  const result = {};


  for (
    const [
      rawKey,
      rawValue
    ]
    of Object.entries(
      value
    )
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


    // --------------------------------------------------------
    // ARRAYS
    // --------------------------------------------------------

    if (
      Array.isArray(
        rawValue
      )
    ) {

      const cleanedArray =
        rawValue.filter(
          item =>
            item !== null &&
            item !== undefined &&
            item !== ""
        );


      if (
        cleanedArray.length === 0
      ) {

        continue;

      }


      result[field] =
        cleanedArray;


      continue;

    }


    // --------------------------------------------------------
    // NORMAL VALUE
    // --------------------------------------------------------

    result[field] =
      rawValue;

  }


  return result;

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

  console.log(
    `[KNOWLEDGE] Processing field: ${field}`
  );


  // ========================================================
  // CHECK EXISTING FIELD
  // ========================================================

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

        method:
          "GET",

        headers:
          supabaseHeaders(env)

      }
    );


  if (
    !existingResponse.ok
  ) {

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


  // ========================================================
  // MERGE ARRAYS
  // ========================================================

  if (
    existingRows.length > 0 &&
    Array.isArray(
      existingRows[0].data
    ) &&
    Array.isArray(
      value
    )
  ) {

    finalValue =
      removeDuplicateValues(
        [
          ...existingRows[0].data,
          ...value
        ]
      );

  }


  // ========================================================
  // MERGE OBJECTS
  // ========================================================

  else if (
    existingRows.length > 0 &&
    isPlainObject(
      existingRows[0].data
    ) &&
    isPlainObject(
      value
    )
  ) {

    finalValue = {

      ...existingRows[0].data,

      ...value

    };

  }


  // ========================================================
  // UPSERT
  // ========================================================

  const upsertUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?on_conflict=application_id,field`;


  const response =
    await fetch(
      upsertUrl,
      {

        method:
          "POST",

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


  if (
    !response.ok
  ) {

    const errorText =
      await response.text();


    console.error(
      "[KNOWLEDGE] Save error:",
      errorText
    );


    throw new Error(
      `Could not save business_knowledge: ${errorText}`
    );

  }


  console.log(
    `[KNOWLEDGE] Saved successfully: ${field}`
  );

}


// ============================================================
// UPDATE ai_status
// ============================================================

async function updateStatus(
  id,
  status,
  env
) {

  console.log(
    `[STATUS] Updating ${id} -> ${status}`
  );


  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}`;


  const response =
    await fetch(
      url,
      {

        method:
          "PATCH",

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


  if (
    !response.ok
  ) {

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
    const item
    of array
  ) {

    let key;


    if (
      item !== null &&
      typeof item === "object"
    ) {

      key =
        JSON.stringify(
          item
        );

    }

    else {

      key =
        String(item)
          .trim()
          .toLowerCase();

    }


    if (
      !seen.has(key)
    ) {

      seen.add(key);

      result.push(
        item
      );

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
