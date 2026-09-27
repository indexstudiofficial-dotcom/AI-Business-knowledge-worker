// ============================================================
// AI BUSINESS KNOWLEDGE WORKER
// ============================================================

const SARVAM_URL = "https://api.sarvam.ai/v1/chat/completions";
const SARVAM_MODEL = "sarvam-105b";
const MAX_TEXT_CHARS = 100000;


// ============================================================
// MAIN HTTP HANDLER
// Supabase Webhook -> this Worker
// ============================================================

export default {
  async fetch(request, env) {
    console.log("[WORKER] HTTP request received");

    // ----------------------------------------------------------
    // CORS
    // ----------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

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
      console.log("[1] Checking environment variables...");

      if (!env.SUPABASE_URL) {
        throw new Error("SUPABASE_URL is missing");
      }

      if (!env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
      }

      if (!env.SARVAM_API_KEY) {
        throw new Error("SARVAM_API_KEY is missing");
      }

      // --------------------------------------------------------
      // Read Supabase webhook
      // --------------------------------------------------------

      const payload = await request.json();

      console.log("[2] Webhook received");
      console.log("[2] Webhook type:", payload.type);
      console.log("[2] Webhook table:", payload.table);

      if (payload.type !== "INSERT") {
        return jsonResponse({
          success: true,
          skipped: true,
          reason: "Not an INSERT event"
        });
      }

      if (payload.table !== "business_data") {
        return jsonResponse({
          success: true,
          skipped: true,
          reason: "Not business_data table"
        });
      }

      const record = payload.record;

      if (!record) {
        throw new Error("Webhook record is missing");
      }

      console.log("[3] business_data ID:", record.id);
      console.log("[3] application_id:", record.application_id);
      console.log("[3] field:", record.field);
      console.log("[3] ai_status:", record.ai_status);

      // --------------------------------------------------------
      // Only process page rows
      // --------------------------------------------------------

      if (record.field !== "page") {
        return jsonResponse({
          success: true,
          skipped: true,
          reason: "Only field=page is processed"
        });
      }

      // --------------------------------------------------------
      // Only process pending rows
      // --------------------------------------------------------

      if (record.ai_status !== "pending") {
        return jsonResponse({
          success: true,
          skipped: true,
          reason: `ai_status is ${record.ai_status}`
        });
      }

      // --------------------------------------------------------
      // Process the page
      // --------------------------------------------------------

      await processBusinessData(record, env);

      console.log("[WORKER] Processing completed successfully");

      return jsonResponse({
        success: true,
        processed: true,
        business_data_id: record.id,
        application_id: record.application_id
      });

    } catch (error) {

      console.error("[WORKER] ERROR:", error);

      return jsonResponse(
        {
          success: false,
          error: error.message || String(error)
        },
        500
      );
    }
  },


  // ============================================================
  // CLOUDFLARE QUEUE HANDLER
  //
  // IMPORTANT:
  // Your Cloudflare Worker still has an old Queue consumer
  // attached in the Dashboard.
  //
  // This handler exists only so Cloudflare accepts the deployment.
  //
  // We are NOT using Queue for the new AI workflow.
  // ============================================================

  async queue(batch, env) {

    console.log(
      `[QUEUE] Received ${batch.messages.length} old queue message(s)`
    );

    for (const message of batch.messages) {

      console.log("[QUEUE] Ignoring old queue message");

      // Acknowledge the old message so it does not retry forever.
      message.ack();
    }

    console.log("[QUEUE] Old queue messages acknowledged");
  }
};


// ============================================================
// PROCESS BUSINESS DATA
// ============================================================

async function processBusinessData(record, env) {

  console.log("[4] Setting ai_status = processing");

  await updateStatus(
    record.id,
    "processing",
    env
  );

  try {

    // ----------------------------------------------------------
    // Read raw page text
    // ----------------------------------------------------------

    console.log("[5] Reading business_data.data");

    let rawText = "";

    if (typeof record.data === "string") {
      rawText = record.data;
    } else if (record.data && typeof record.data === "object") {
      rawText = JSON.stringify(record.data);
    } else {
      throw new Error("business_data.data is empty");
    }

    rawText = rawText.trim();

    if (!rawText) {
      throw new Error("business_data.data contains no text");
    }

    // Prevent extremely large AI requests.
    if (rawText.length > MAX_TEXT_CHARS) {
      rawText = rawText.substring(0, MAX_TEXT_CHARS);
    }

    console.log(
      `[6] Text length: ${rawText.length} characters`
    );

    // ----------------------------------------------------------
    // Call Sarvam
    // ----------------------------------------------------------

    console.log("[7] Calling Sarvam...");

    const extractedData = await callSarvam(
      rawText,
      record.source_url || "",
      env
    );

    console.log("[8] Sarvam extraction completed");

    console.log(
      "[8] Extracted fields:",
      Object.keys(extractedData)
    );

    // ----------------------------------------------------------
    // Save extracted information
    // ----------------------------------------------------------

    for (const [field, value] of Object.entries(extractedData)) {

      if (
        value === null ||
        value === undefined ||
        value === ""
      ) {
        continue;
      }

      console.log(
        `[9] Saving field: ${field}`
      );

      await saveKnowledge(
        record.application_id,
        field,
        value,
        env
      );
    }

    // ----------------------------------------------------------
    // Mark original page as completed
    // ----------------------------------------------------------

    console.log("[10] Setting ai_status = completed");

    await updateStatus(
      record.id,
      "completed",
      env
    );

    console.log("[PROCESS] Finished successfully");

  } catch (error) {

    console.error(
      "[PROCESS] Failed:",
      error
    );

    // ----------------------------------------------------------
    // Mark page as failed
    // ----------------------------------------------------------

    try {

      await updateStatus(
        record.id,
        "failed",
        env
      );

    } catch (statusError) {

      console.error(
        "[PROCESS] Could not update failed status:",
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

You will receive RAW TEXT scraped from a business website.

Your job is to extract ONLY real business information.

IMPORTANT RULES:

1. Do NOT hallucinate.
2. Do NOT invent information.
3. Do NOT assume missing information.
4. Ignore navigation menus.
5. Ignore footer templates.
6. Ignore placeholder/demo information.
7. Ignore fake/template phone numbers.
8. Ignore fake/template emails.
9. Ignore Lorem Ipsum.
10. Ignore generic website template content.
11. Ignore information that clearly belongs to another person or demo website.
12. Only extract information that appears to belong to the actual business.
13. If something is uncertain, do not include it.
14. Do not include empty fields.
15. Return ONLY valid JSON.
16. Use simple semantic field names.

Useful fields include:

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

For lists such as services, return JSON arrays.

For structured information, return JSON objects.

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
  },
  "hours": {
    "monday": "9:00 AM - 8:00 PM",
    "tuesday": "9:00 AM - 8:00 PM"
  }
}

Again:

ONLY return information supported by the supplied text.
`;

  const userPrompt = `
SOURCE URL:
${sourceUrl || "Unknown"}

RAW WEBSITE TEXT:
${rawText}
`;

  const response = await fetch(
    SARVAM_URL,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
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

  const responseText = await response.text();

  if (!response.ok) {

    console.error(
      "[SARVAM] Error response:",
      responseText
    );

    throw new Error(
      `Sarvam API failed with HTTP ${response.status}`
    );
  }

  let responseJson;

  try {

    responseJson = JSON.parse(responseText);

  } catch {

    console.error(
      "[SARVAM] Invalid JSON response:",
      responseText
    );

    throw new Error(
      "Sarvam returned invalid JSON"
    );
  }

  // ----------------------------------------------------------
  // Extract model content
  // ----------------------------------------------------------

  let content =
    responseJson?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      "Sarvam response does not contain message content"
    );
  }

  // Sometimes APIs return content as an object.
  if (typeof content === "object") {
    return cleanExtractedObject(content);
  }

  // Sometimes JSON is wrapped in markdown.
  content = content
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let extracted;

  try {

    extracted = JSON.parse(content);

  } catch {

    console.error(
      "[SARVAM] Could not parse model JSON:",
      content
    );

    throw new Error(
      "Sarvam returned JSON that could not be parsed"
    );
  }

  return cleanExtractedObject(extracted);
}


// ============================================================
// CLEAN AI OUTPUT
// ============================================================

function cleanExtractedObject(value) {

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      "AI returned an invalid extraction object"
    );
  }

  const result = {};

  for (const [rawKey, rawValue] of Object.entries(value)) {

    if (!rawKey) {
      continue;
    }

    const field = rawKey
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");

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

    // Remove empty array values.
    if (Array.isArray(rawValue)) {

      const cleanedArray = rawValue.filter(
        item =>
          item !== null &&
          item !== undefined &&
          item !== ""
      );

      if (cleanedArray.length === 0) {
        continue;
      }

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

async function saveKnowledge(
  applicationId,
  field,
  value,
  env
) {

  // ----------------------------------------------------------
  // Check if this field already exists
  // ----------------------------------------------------------

  const existingUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}` +
    `&select=id,data` +
    `&limit=1`;

  const existingResponse = await fetch(
    existingUrl,
    {
      method: "GET",

      headers: supabaseHeaders(env)
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

  let finalValue = value;

  // ----------------------------------------------------------
  // If existing value is an array,
  // merge without duplicate values.
  // ----------------------------------------------------------

  if (
    existingRows.length > 0 &&
    Array.isArray(existingRows[0].data) &&
    Array.isArray(value)
  ) {

    const combined = [
      ...existingRows[0].data,
      ...value
    ];

    finalValue = removeDuplicateValues(
      combined
    );
  }

  // ----------------------------------------------------------
  // If both are objects, merge them.
  // ----------------------------------------------------------

  else if (
    existingRows.length > 0 &&
    isPlainObject(existingRows[0].data) &&
    isPlainObject(value)
  ) {

    finalValue = {
      ...existingRows[0].data,
      ...value
    };
  }

  // ----------------------------------------------------------
  // Upsert
  // ----------------------------------------------------------

  const upsertUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?on_conflict=application_id,field`;

  const response = await fetch(
    upsertUrl,
    {
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
    }
  );

  if (!response.ok) {

    const errorText =
      await response.text();

    console.error(
      "[KNOWLEDGE] Supabase error:",
      errorText
    );

    throw new Error(
      `Could not save business_knowledge: ${errorText}`
    );
  }

  console.log(
    `[KNOWLEDGE] Saved: ${field}`
  );
}


// ============================================================
// UPDATE business_data.ai_status
// ============================================================

async function updateStatus(
  id,
  status,
  env
) {

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}`;

  const response = await fetch(
    url,
    {
      method: "PATCH",

      headers: {
        ...supabaseHeaders(env),
        "Prefer": "return=minimal"
      },

      body: JSON.stringify({
        ai_status: status,
        updated_at: new Date().toISOString()
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
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization":
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
}


// ============================================================
// DUPLICATE REMOVER
// ============================================================

function removeDuplicateValues(array) {

  const seen = new Set();

  const result = [];

  for (const item of array) {

    let key;

    if (
      item !== null &&
      typeof item === "object"
    ) {

      key = JSON.stringify(item);

    } else {

      key = String(item)
        .trim()
        .toLowerCase();
    }

    if (!seen.has(key)) {

      seen.add(key);

      result.push(item);
    }
  }

  return result;
}


// ============================================================
// OBJECT CHECK
// ============================================================

function isPlainObject(value) {

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
    JSON.stringify(data, null, 2),
    {
      status,

      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json"
      }
    }
  );
}


// ============================================================
// CORS
// ============================================================

function corsHeaders() {

  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
  };
    }
