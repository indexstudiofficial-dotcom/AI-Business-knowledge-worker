// ============================================================
// BUSINESS DATA → AI KNOWLEDGE WORKER
// ============================================================
//
// FLOW:
//
// Supabase business_data INSERT
//        ↓
// Supabase Database Webhook
//        ↓
// Cloudflare Worker
//        ↓
// Read raw business_data.data
//        ↓
// Send to Sarvam 105B
//        ↓
// Get structured JSON
//        ↓
// Save into business_knowledge.data
//        ↓
// Mark business_data.ai_status = completed
//
// NO CLOUDFLARE QUEUE
// ============================================================


// ============================================================
// CONFIG
// ============================================================

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";

const SARVAM_MODEL = "sarvam-105b";

// Maximum raw text sent to AI.
// 100,000 characters is safely below the 128K context window
// of Sarvam 105B.
const MAX_TEXT_CHARS = 100000;


// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(request, env, ctx) {

    console.log("========================================");
    console.log("[WORKER] Request received");
    console.log("========================================");


    // --------------------------------------------------------
    // CORS / OPTIONS
    // --------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response("ok", {
        status: 200
      });
    }


    // --------------------------------------------------------
    // ONLY POST
    // --------------------------------------------------------

    if (request.method !== "POST") {

      return jsonResponse({
        success: false,
        error: "Only POST requests are allowed"
      }, 405);

    }


    // --------------------------------------------------------
    // CHECK REQUIRED ENVIRONMENT VARIABLES
    // --------------------------------------------------------

    console.log("[1] Checking environment variables...");

    if (!env.SUPABASE_URL) {
      console.error("[ERROR] SUPABASE_URL is missing");

      return jsonResponse({
        success: false,
        error: "SUPABASE_URL is missing"
      }, 500);
    }

    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error("[ERROR] SUPABASE_SERVICE_ROLE_KEY is missing");

      return jsonResponse({
        success: false,
        error: "SUPABASE_SERVICE_ROLE_KEY is missing"
      }, 500);
    }

    if (!env.SARVAM_API_KEY) {
      console.error("[ERROR] SARVAM_API_KEY is missing");

      return jsonResponse({
        success: false,
        error: "SARVAM_API_KEY is missing"
      }, 500);
    }

    console.log("[1] Environment variables OK");


    // --------------------------------------------------------
    // READ WEBHOOK BODY
    // --------------------------------------------------------

    let payload;

    try {

      payload = await request.json();

    } catch (error) {

      console.error("[ERROR] Invalid JSON body", error);

      return jsonResponse({
        success: false,
        error: "Invalid JSON body"
      }, 400);

    }


    console.log("[2] Webhook received");
    console.log("[2] Webhook type:", payload?.type);
    console.log("[2] Webhook table:", payload?.table);


    // --------------------------------------------------------
    // GET DATABASE RECORD
    // --------------------------------------------------------

    const record = payload?.record;

    if (!record) {

      console.error("[ERROR] Webhook record is missing");

      return jsonResponse({
        success: false,
        error: "Webhook record is missing"
      }, 400);

    }


    console.log("[3] Record received");
    console.log("[3] ID:", record.id);
    console.log("[3] Application ID:", record.application_id);
    console.log("[3] Field:", record.field);
    console.log("[3] AI status:", record.ai_status);


    // --------------------------------------------------------
    // ONLY PROCESS business_data
    // --------------------------------------------------------

    if (payload.table && payload.table !== "business_data") {

      console.log("[SKIP] This is not business_data");

      return jsonResponse({
        success: true,
        skipped: true,
        reason: "Wrong table"
      });

    }


    // --------------------------------------------------------
    // ONLY PROCESS INSERT
    // --------------------------------------------------------

    if (payload.type && payload.type !== "INSERT") {

      console.log("[SKIP] This is not an INSERT");

      return jsonResponse({
        success: true,
        skipped: true,
        reason: "Not an INSERT event"
      });

    }


    // --------------------------------------------------------
    // ONLY PROCESS PAGE ROWS
    // --------------------------------------------------------

    if (record.field !== "page") {

      console.log("[SKIP] field is not 'page'");

      return jsonResponse({
        success: true,
        skipped: true,
        reason: "Field is not page"
      });

    }


    // --------------------------------------------------------
    // ONLY PROCESS PENDING ROWS
    // --------------------------------------------------------

    if (
      record.ai_status &&
      record.ai_status !== "pending"
    ) {

      console.log(
        "[SKIP] ai_status is:",
        record.ai_status
      );

      return jsonResponse({
        success: true,
        skipped: true,
        reason: `ai_status is ${record.ai_status}`
      });

    }


    // --------------------------------------------------------
    // VALIDATE REQUIRED DATA
    // --------------------------------------------------------

    if (!record.id) {

      console.error("[ERROR] business_data.id missing");

      return jsonResponse({
        success: false,
        error: "business_data.id is missing"
      }, 400);

    }

    if (!record.application_id) {

      console.error("[ERROR] application_id missing");

      return jsonResponse({
        success: false,
        error: "application_id is missing"
      }, 400);

    }


    // --------------------------------------------------------
    // IMPORTANT:
    //
    // Start the actual AI work in the background.
    //
    // This lets Supabase receive a quick 200 response while
    // Cloudflare continues processing.
    // --------------------------------------------------------

    ctx.waitUntil(
      processBusinessData(record, env)
    );


    // --------------------------------------------------------
    // RETURN IMMEDIATELY TO SUPABASE
    // --------------------------------------------------------

    console.log("[4] Background processing started");

    return jsonResponse({
      success: true,
      processing: true,
      business_data_id: record.id,
      application_id: record.application_id
    }, 200);
  }
};


// ============================================================
// PROCESS BUSINESS DATA
// ============================================================

async function processBusinessData(record, env) {

  console.log("");
  console.log("========================================");
  console.log("[PROCESS] Starting AI processing");
  console.log("========================================");


  const businessDataId = record.id;
  const applicationId = record.application_id;


  try {

    // --------------------------------------------------------
    // STEP 1
    // Mark raw row as PROCESSING
    // --------------------------------------------------------

    console.log("[5] Marking row as processing...");

    await updateBusinessDataStatus(
      businessDataId,
      "processing",
      env
    );

    console.log("[5] Status = processing");


    // --------------------------------------------------------
    // STEP 2
    // Get raw text
    // --------------------------------------------------------

    console.log("[6] Reading raw business data...");

    const rawText = extractRawText(record.data);

    if (!rawText || rawText.trim().length === 0) {

      throw new Error(
        "business_data.data is empty"
      );

    }

    console.log(
      "[6] Raw text length:",
      rawText.length
    );


    // --------------------------------------------------------
    // STEP 3
    // Limit text size
    // --------------------------------------------------------

    const textForAI =
      rawText.length > MAX_TEXT_CHARS
        ? rawText.slice(0, MAX_TEXT_CHARS)
        : rawText;

    console.log(
      "[7] Text sent to AI:",
      textForAI.length,
      "characters"
    );


    // --------------------------------------------------------
    // STEP 4
    // Send to Sarvam
    // --------------------------------------------------------

    console.log("[8] Sending data to Sarvam...");

    const aiResult = await analyzeWithSarvam(
      textForAI,
      env
    );

    console.log("[8] Sarvam response received");


    // --------------------------------------------------------
    // STEP 5
    // Validate AI result
    // --------------------------------------------------------

    if (
      !aiResult ||
      typeof aiResult !== "object" ||
      Array.isArray(aiResult)
    ) {

      throw new Error(
        "Sarvam returned invalid structured data"
      );

    }

    console.log(
      "[9] AI extracted fields:",
      Object.keys(aiResult)
    );


    // --------------------------------------------------------
    // STEP 6
    // Save every extracted field
    // into business_knowledge
    // --------------------------------------------------------

    let savedCount = 0;

    for (const [field, value] of Object.entries(aiResult)) {

      // Ignore empty values
      if (isEmptyValue(value)) {

        console.log(
          `[10] Skipping empty field: ${field}`
        );

        continue;

      }


      console.log(
        `[10] Saving field: ${field}`
      );


      await saveBusinessKnowledge(
        applicationId,
        field,
        value,
        env
      );


      savedCount++;

      console.log(
        `[10] Saved field: ${field}`
      );
    }


    // --------------------------------------------------------
    // STEP 7
    // Mark original business_data row completed
    // --------------------------------------------------------

    console.log(
      `[11] ${savedCount} knowledge fields saved`
    );

    await updateBusinessDataStatus(
      businessDataId,
      "completed",
      env
    );

    console.log(
      "[12] business_data status = completed"
    );


    console.log("");
    console.log("========================================");
    console.log("[SUCCESS] AI processing completed");
    console.log("========================================");
    console.log("");


  } catch (error) {

    console.error("");
    console.error("========================================");
    console.error("[FAILED] AI processing failed");
    console.error("========================================");
    console.error(
      "[ERROR]",
      error?.message || error
    );
    console.error("");


    // --------------------------------------------------------
    // Mark original row as FAILED
    // --------------------------------------------------------

    try {

      await updateBusinessDataStatus(
        businessDataId,
        "failed",
        env
      );

      console.log(
        "[FAILED] business_data status = failed"
      );

    } catch (statusError) {

      console.error(
        "[ERROR] Could not update failed status:",
        statusError
      );

    }

  }
}


// ============================================================
// EXTRACT RAW TEXT
// ============================================================

function extractRawText(data) {

  // If data is already a string
  if (typeof data === "string") {
    return data;
  }


  // If data is an object
  if (
    data &&
    typeof data === "object"
  ) {

    // Common structure:
    // { "text": "..." }

    if (
      typeof data.text === "string"
    ) {

      return data.text;

    }


    // Otherwise convert entire JSON object
    // into readable text

    return JSON.stringify(data);

  }


  return String(data ?? "");
}


// ============================================================
// SEND DATA TO SARVAM
// ============================================================

async function analyzeWithSarvam(
  rawText,
  env
) {

  const systemPrompt = `
You are a business information extraction AI.

You will receive raw text scraped from a business website.

Your job is to extract ONLY real information that clearly belongs
to the actual business.

IMPORTANT RULES:

1. NEVER invent information.
2. NEVER guess missing information.
3. Ignore Lorem ipsum.
4. Ignore demo/template content.
5. Ignore placeholder information such as:
   - info@example.com
   - example.com
   - website.com
   - fake/demo phone numbers
   - generic theme content
6. Ignore navigation menus unless they contain useful business data.
7. Ignore repeated headers and footers when they contain no new information.
8. If the same information appears multiple times, return it only once.
9. Preserve real phone numbers, emails, addresses, services and hours exactly when possible.
10. If a field is not present, DO NOT create it.
11. Do not return explanations.
12. Return ONLY valid JSON.

Use these possible fields when the information exists:

business_profile
business_name
business_type
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

For arrays such as services, remove duplicate values.

For objects, use clear property names.

Example output:

{
  "business_name": "Dr Johnys Dental Clinic",
  "business_type": "Dental Clinic",
  "services": [
    "Root Canal Treatment",
    "Tooth Extraction",
    "Braces and Aligners"
  ],
  "phone": "+91 79947 43699",
  "address": "Palakkad, Kerala",
  "hours": {
    "monday": "9:00 AM - 8:00 PM",
    "tuesday": "9:00 AM - 8:00 PM"
  }
}

Again:

ONLY return information supported by the supplied website text.
Do not hallucinate.
`;


  const userPrompt = `
Extract the real business information from this website text.

WEBSITE TEXT:
--------------------
${rawText}
--------------------
`;


  const response = await fetch(
    SARVAM_URL,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",

        // Current Sarvam authentication header
        "api-subscription-key": env.SARVAM_API_KEY
      },

      body: JSON.stringify({

        model: SARVAM_MODEL,

        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: userPrompt
          }
        ],

        // Ask Sarvam for valid JSON
        response_format: {
          type: "json_object"
        },

        // We don't need extremely long output
        max_tokens: 4096,

        // Low temperature for extraction
        temperature: 0.2
      })
    }
  );


  // --------------------------------------------------------
  // Read response body
  // --------------------------------------------------------

  const responseText =
    await response.text();


  console.log(
    "[SARVAM] HTTP status:",
    response.status
  );


  // --------------------------------------------------------
  // Handle API error
  // --------------------------------------------------------

  if (!response.ok) {

    console.error(
      "[SARVAM ERROR]",
      responseText
    );

    throw new Error(
      `Sarvam API error ${response.status}: ${responseText}`
    );

  }


  // --------------------------------------------------------
  // Parse Sarvam response
  // --------------------------------------------------------

  let responseJson;

  try {

    responseJson =
      JSON.parse(responseText);

  } catch (error) {

    console.error(
      "[SARVAM ERROR] Response was not JSON"
    );

    throw new Error(
      "Sarvam returned invalid HTTP JSON"
    );

  }


  // --------------------------------------------------------
  // Get assistant content
  // --------------------------------------------------------

  const content =
    responseJson?.choices?.[0]?.message?.content;


  if (!content) {

    console.error(
      "[SARVAM ERROR] No assistant content"
    );

    console.error(
      JSON.stringify(responseJson)
    );

    throw new Error(
      "Sarvam response did not contain message content"
    );

  }


  console.log(
    "[SARVAM] AI content received"
  );


  // --------------------------------------------------------
  // Parse AI JSON
  // --------------------------------------------------------

  let extracted;

  try {

    extracted =
      typeof content === "string"
        ? JSON.parse(content)
        : content;

  } catch (error) {

    console.error(
      "[SARVAM ERROR] AI content was not valid JSON"
    );

    console.error(content);

    throw new Error(
      "Sarvam returned invalid structured JSON"
    );

  }


  return cleanExtractedData(extracted);
}


// ============================================================
// CLEAN AI RESULT
// ============================================================

function cleanExtractedData(data) {

  if (
    !data ||
    typeof data !== "object"
  ) {

    return {};

  }


  const cleaned = {};


  for (
    const [rawField, rawValue]
    of Object.entries(data)
  ) {

    // Normalize field name
    const field =
      normalizeFieldName(rawField);


    // Clean value
    const value =
      cleanValue(rawValue);


    // Ignore empty values
    if (isEmptyValue(value)) {
      continue;
    }


    // If same normalized field appears twice,
    // merge it instead of creating duplicate data.
    if (
      Object.prototype.hasOwnProperty.call(
        cleaned,
        field
      )
    ) {

      cleaned[field] =
        mergeValues(
          cleaned[field],
          value
        );

    } else {

      cleaned[field] = value;

    }
  }


  return cleaned;
}


// ============================================================
// NORMALIZE FIELD NAME
// ============================================================

function normalizeFieldName(field) {

  return String(field)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);

}


// ============================================================
// CLEAN VALUES
// ============================================================

function cleanValue(value) {

  // String
  if (typeof value === "string") {

    return value.trim();

  }


  // Array
  if (Array.isArray(value)) {

    const cleanedArray =
      value
        .map(item => cleanValue(item))
        .filter(item => !isEmptyValue(item));


    // Remove duplicates
    return removeDuplicates(
      cleanedArray
    );

  }


  // Object
  if (
    value &&
    typeof value === "object"
  ) {

    const cleanedObject = {};


    for (
      const [key, item]
      of Object.entries(value)
    ) {

      const cleanedItem =
        cleanValue(item);


      if (
        !isEmptyValue(cleanedItem)
      ) {

        cleanedObject[key] =
          cleanedItem;

      }

    }


    return cleanedObject;

  }


  return value;
}


// ============================================================
// REMOVE DUPLICATES
// ============================================================

function removeDuplicates(array) {

  const seen = new Set();

  const result = [];


  for (const item of array) {

    let key;

    try {

      key = JSON.stringify(item);

    } catch {

      key = String(item);

    }


    if (!seen.has(key)) {

      seen.add(key);

      result.push(item);

    }

  }


  return result;
}


// ============================================================
// MERGE VALUES
// ============================================================

function mergeValues(oldValue, newValue) {

  // Array + array
  if (
    Array.isArray(oldValue) &&
    Array.isArray(newValue)
  ) {

    return removeDuplicates([
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


  // Otherwise new information replaces old
  return newValue;
}


// ============================================================
// CHECK EMPTY VALUE
// ============================================================

function isEmptyValue(value) {

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
// SAVE INTO business_knowledge
// ============================================================

async function saveBusinessKnowledge(
  applicationId,
  field,
  newValue,
  env
) {

  console.log(
    `[KNOWLEDGE] Checking existing field: ${field}`
  );


  // --------------------------------------------------------
  // STEP 1:
  // Check whether this application already has this field.
  // --------------------------------------------------------

  const existingUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}` +
    `&select=id,data`;


  const existingResponse =
    await fetch(
      existingUrl,
      {
        method: "GET",

        headers: supabaseHeaders(env)
      }
    );


  const existingText =
    await existingResponse.text();


  if (!existingResponse.ok) {

    throw new Error(
      `Could not check business_knowledge: ${existingResponse.status} ${existingText}`
    );

  }


  let existingRows = [];

  try {

    existingRows =
      JSON.parse(existingText);

  } catch {

    existingRows = [];

  }


  // --------------------------------------------------------
  // STEP 2:
  // Merge with existing data if the field already exists.
  // --------------------------------------------------------

  let finalValue = newValue;


  if (
    existingRows.length > 0
  ) {

    console.log(
      `[KNOWLEDGE] Existing field found: ${field}`
    );


    const oldValue =
      existingRows[0].data;


    finalValue =
      mergeValues(
        oldValue,
        newValue
      );

  } else {

    console.log(
      `[KNOWLEDGE] New field: ${field}`
    );

  }


  // --------------------------------------------------------
  // STEP 3:
  // UPSERT
  //
  // Requires:
  // UNIQUE(application_id, field)
  // --------------------------------------------------------

  const upsertUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?on_conflict=application_id,field`;


  const body = {

    application_id:
      applicationId,

    field:
      field,

    data:
      finalValue,

    updated_at:
      new Date().toISOString()
  };


  const upsertResponse =
    await fetch(
      upsertUrl,
      {
        method: "POST",

        headers: {
          ...supabaseHeaders(env),

          "Prefer":
            "resolution=merge-duplicates,return=minimal"
        },

        body:
          JSON.stringify(body)
      }
    );


  const upsertText =
    await upsertResponse.text();


  if (!upsertResponse.ok) {

    console.error(
      "[KNOWLEDGE ERROR]",
      upsertText
    );

    throw new Error(
      `Could not save business_knowledge: ${upsertResponse.status} ${upsertText}`
    );

  }


  console.log(
    `[KNOWLEDGE] Saved: ${field}`
  );
}


// ============================================================
// UPDATE business_data.ai_status
// ============================================================

async function updateBusinessDataStatus(
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
            ai_status: status,
            updated_at:
              new Date().toISOString()
          })
      }
    );


  const responseText =
    await response.text();


  if (!response.ok) {

    throw new Error(
      `Could not update business_data status: ${response.status} ${responseText}`
    );

  }

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

function jsonResponse(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data, null, 2),
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
