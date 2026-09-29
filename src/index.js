/**
 * Reportli AI
 * Business Knowledge Worker
 *
 * NO AI
 * NO Sarvam
 * NO OpenAI
 * NO website scraping
 *
 * Flow:
 *
 * business_data INSERT
 *       ↓
 * Supabase Database Webhook
 *       ↓
 * This Worker
 *       ↓
 * Generic rule-based extraction
 *       ↓
 * business_knowledge
 */

export default {
  async fetch(request, env) {
    // ---------------------------------------------------------
    // 1. Basic HTTP handling
    // ---------------------------------------------------------

    if (request.method === "GET") {
      return jsonResponse({
        success: true,
        worker: "ai-business-knowledge-worker",
        mode: "webhook",
        ai: false,
        message: "Business Knowledge Worker is running"
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

    // ---------------------------------------------------------
    // 2. Parse webhook body
    // ---------------------------------------------------------

    let payload;

    try {
      payload = await request.json();
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: "Invalid JSON body"
        },
        400
      );
    }

    console.log("Received webhook:", JSON.stringify(payload));

    // ---------------------------------------------------------
    // 3. Extract business_data record
    // ---------------------------------------------------------

    const record = getBusinessDataRecord(payload);

    if (!record) {
      console.error("Could not find business_data record");

      return jsonResponse(
        {
          success: false,
          error: "Could not find business_data record in webhook payload"
        },
        400
      );
    }

    const applicationId = record.application_id;
    const businessDataId = record.id;
    const sourceUrl = record.source_url || null;

    if (!applicationId) {
      return jsonResponse(
        {
          success: false,
          error: "application_id is missing"
        },
        400
      );
    }

    if (!businessDataId) {
      return jsonResponse(
        {
          success: false,
          error: "business_data id is missing"
        },
        400
      );
    }

    // ---------------------------------------------------------
    // 4. Mark source row as processing
    // ---------------------------------------------------------

    await updateBusinessDataStatus(
      env,
      businessDataId,
      "processing",
      null
    );

    try {
      // -------------------------------------------------------
      // 5. Extract raw page data
      // -------------------------------------------------------

      const rawData = record.data;

      if (
        rawData === null ||
        rawData === undefined ||
        rawData === ""
      ) {
        throw new Error("business_data.data is empty");
      }

      // -------------------------------------------------------
      // 6. Generic extraction
      // -------------------------------------------------------

      const extracted = extractKnowledge(rawData);

      console.log(
        "Extracted knowledge:",
        JSON.stringify(extracted)
      );

      // -------------------------------------------------------
      // 7. Save extracted knowledge
      // -------------------------------------------------------

      let savedCount = 0;

      for (const item of extracted) {
        if (!item.field) {
          continue;
        }

        if (
          item.data === null ||
          item.data === undefined ||
          item.data === ""
        ) {
          continue;
        }

        await upsertKnowledge(
          env,
          applicationId,
          item.field,
          item.data,
          sourceUrl
        );

        savedCount++;
      }

      // -------------------------------------------------------
      // 8. Mark source row as completed
      // -------------------------------------------------------

      await updateBusinessDataStatus(
        env,
        businessDataId,
        "completed",
        null
      );

      console.log(
        `Completed application ${applicationId}. Saved ${savedCount} knowledge fields.`
      );

      return jsonResponse({
        success: true,
        ai: false,
        application_id: applicationId,
        business_data_id: businessDataId,
        fields_saved: savedCount
      });
    } catch (error) {
      console.error("Knowledge extraction failed:", error);

      await updateBusinessDataStatus(
        env,
        businessDataId,
        "failed",
        error.message
      );

      return jsonResponse(
        {
          success: false,
          ai: false,
          error: error.message
        },
        500
      );
    }
  }
};


// =============================================================
// WEBHOOK RECORD EXTRACTION
// =============================================================

function getBusinessDataRecord(payload) {
  /*
   * Supabase Database Webhook normally sends:
   *
   * {
   *   id,
   *   application_id,
   *   field,
   *   data,
   *   source_url,
   *   ...
   * }
   *
   * We also support common wrapped formats.
   */

  if (
    payload &&
    payload.id &&
    payload.application_id &&
    Object.prototype.hasOwnProperty.call(payload, "data")
  ) {
    return payload;
  }

  if (payload?.record) {
    return payload.record;
  }

  if (payload?.new_record) {
    return payload.new_record;
  }

  if (payload?.data?.record) {
    return payload.data.record;
  }

  if (payload?.data?.new_record) {
    return payload.data.new_record;
  }

  return null;
}


// =============================================================
// MAIN GENERIC EXTRACTOR
// =============================================================

function extractKnowledge(rawData) {
  const results = [];

  // -----------------------------------------------------------
  // CASE 1: Structured JSON object
  // -----------------------------------------------------------

  if (
    typeof rawData === "object" &&
    rawData !== null &&
    !Array.isArray(rawData)
  ) {
    extractObject(rawData, results);
  }

  // -----------------------------------------------------------
  // CASE 2: Array
  // -----------------------------------------------------------

  else if (Array.isArray(rawData)) {
    extractArray(rawData, results);
  }

  // -----------------------------------------------------------
  // CASE 3: Raw text
  // -----------------------------------------------------------

  else if (typeof rawData === "string") {
    extractText(rawData, results);
  }

  // -----------------------------------------------------------
  // CASE 4: Number / boolean / other
  // -----------------------------------------------------------

  else {
    results.push({
      field: "pending",
      data: rawData
    });
  }

  return cleanResults(results);
}


// =============================================================
// OBJECT EXTRACTION
// =============================================================

function extractObject(obj, results, parentKey = "") {
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    if (
      rawKey === null ||
      rawKey === undefined ||
      rawKey === ""
    ) {
      continue;
    }

    const field = makeFieldName(rawKey);

    // Ignore obvious metadata/junk fields.
    if (isJunkField(field)) {
      continue;
    }

    // ---------------------------------------------------------
    // Nested object
    // ---------------------------------------------------------

    if (
      rawValue &&
      typeof rawValue === "object" &&
      !Array.isArray(rawValue)
    ) {
      extractObject(rawValue, results, field);
      continue;
    }

    // ---------------------------------------------------------
    // Array
    // ---------------------------------------------------------

    if (Array.isArray(rawValue)) {
      const cleanedArray = cleanArray(rawValue);

      if (cleanedArray.length === 0) {
        continue;
      }

      results.push({
        field,
        data: cleanedArray
      });

      continue;
    }

    // ---------------------------------------------------------
    // Primitive value
    // ---------------------------------------------------------

    if (
      rawValue !== null &&
      rawValue !== undefined &&
      String(rawValue).trim() !== ""
    ) {
      const cleanedValue = cleanValue(rawValue);

      if (
        cleanedValue !== null &&
        cleanedValue !== undefined &&
        String(cleanedValue).trim() !== ""
      ) {
        results.push({
          field,
          data: cleanedValue
        });
      }
    }
  }
}


// =============================================================
// ARRAY EXTRACTION
// =============================================================

function extractArray(array, results) {
  const primitiveValues = [];
  const objectValues = [];

  for (const item of array) {
    if (item === null || item === undefined) {
      continue;
    }

    if (
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      objectValues.push(item);
    } else if (Array.isArray(item)) {
      extractArray(item, results);
    } else {
      const cleaned = cleanValue(item);

      if (
        cleaned !== null &&
        cleaned !== undefined &&
        String(cleaned).trim() !== ""
      ) {
        primitiveValues.push(cleaned);
      }
    }
  }

  if (primitiveValues.length > 0) {
    results.push({
      field: "pending",
      data: uniqueValues(primitiveValues)
    });
  }

  for (const obj of objectValues) {
    extractObject(obj, results);
  }
}


// =============================================================
// TEXT EXTRACTION
// =============================================================

function extractText(text, results) {
  // -----------------------------------------------------------
  // 1. Normalize text
  // -----------------------------------------------------------

  const normalized = normalizeText(text);

  if (!normalized) {
    return;
  }

  // -----------------------------------------------------------
  // 2. Split into useful lines
  // -----------------------------------------------------------

  let lines = normalized
    .split("\n")
    .map(line => cleanLine(line))
    .filter(Boolean);

  // -----------------------------------------------------------
  // 3. Remove duplicate lines
  // -----------------------------------------------------------

  lines = uniqueValues(lines);

  // -----------------------------------------------------------
  // 4. Remove obvious website junk
  // -----------------------------------------------------------

  lines = lines.filter(line => !isJunkLine(line));

  if (lines.length === 0) {
    return;
  }

  // -----------------------------------------------------------
  // 5. Detect explicit key/value patterns
  // -----------------------------------------------------------

  const consumedIndexes = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ---------------------------------------------------------
    // Pattern:
    //
    // Phone: +91...
    // Email: hello@example.com
    // Address: ...
    // ---------------------------------------------------------

    const colonMatch = line.match(
      /^([A-Za-z][A-Za-z0-9 _/&().'-]{1,80})\s*:\s*(.+)$/
    );

    if (colonMatch) {
      const field = makeFieldName(colonMatch[1]);
      const value = cleanValue(colonMatch[2]);

      if (
        field &&
        value &&
        !isJunkField(field)
      ) {
        results.push({
          field,
          data: value
        });

        consumedIndexes.add(i);
        continue;
      }
    }

    // ---------------------------------------------------------
    // Pattern:
    //
    // Phone - +91...
    // Email - ...
    // ---------------------------------------------------------

    const dashMatch = line.match(
      /^([A-Za-z][A-Za-z0-9 _/&().'-]{1,80})\s+-\s+(.+)$/
    );

    if (dashMatch) {
      const field = makeFieldName(dashMatch[1]);
      const value = cleanValue(dashMatch[2]);

      if (
        field &&
        value &&
        !isJunkField(field)
      ) {
        results.push({
          field,
          data: value
        });

        consumedIndexes.add(i);
        continue;
      }
    }
  }

  // -----------------------------------------------------------
  // 6. Detect emails
  // -----------------------------------------------------------

  const emails = extractEmails(normalized);

  if (emails.length > 0) {
    results.push({
      field: "email",
      data: emails
    });
  }

  // -----------------------------------------------------------
  // 7. Detect URLs
  // -----------------------------------------------------------

  const urls = extractUrls(normalized);

  if (urls.length > 0) {
    results.push({
      field: "urls",
      data: urls
    });
  }

  // -----------------------------------------------------------
  // 8. Detect phone numbers
  // -----------------------------------------------------------

  const phones = extractPhones(normalized);

  if (phones.length > 0) {
    results.push({
      field: "phone",
      data: phones
    });
  }

  // -----------------------------------------------------------
  // 9. Detect "8000 + CUSTOMERS" type patterns
  // -----------------------------------------------------------

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const metricMatch = line.match(
      /^([\d,.]+)\s*\+\s*([A-Za-z][A-Za-z0-9 _/&().'-]{1,80})$/i
    );

    if (metricMatch) {
      const number = parseNumber(metricMatch[1]);
      const label = makeFieldName(metricMatch[2]);

      if (label) {
        results.push({
          field: label,
          data: number
        });

        consumedIndexes.add(i);
      }
    }
  }

  // -----------------------------------------------------------
  // 10. Detect headings followed by lists
  // -----------------------------------------------------------

  for (let i = 0; i < lines.length; i++) {
    if (consumedIndexes.has(i)) {
      continue;
    }

    const heading = lines[i];

    if (!looksLikeHeading(heading)) {
      continue;
    }

    const list = [];

    let j = i + 1;

    while (j < lines.length) {
      const candidate = lines[j];

      if (consumedIndexes.has(j)) {
        j++;
        continue;
      }

      if (isJunkLine(candidate)) {
        j++;
        continue;
      }

      if (looksLikeHeading(candidate)) {
        break;
      }

      if (looksLikeLongSentence(candidate)) {
        break;
      }

      if (
        containsContactInformation(candidate) ||
        looksLikeUrl(candidate)
      ) {
        break;
      }

      list.push(candidate);
      j++;
    }

    if (list.length >= 2 && list.length <= 30) {
      const field = makeFieldName(heading);

      if (field) {
        results.push({
          field,
          data: uniqueValues(list)
        });

        consumedIndexes.add(i);

        for (let k = i + 1; k < j; k++) {
          consumedIndexes.add(k);
        }
      }
    }
  }

  // -----------------------------------------------------------
  // 11. Detect sentences containing obvious experience
  // -----------------------------------------------------------

  for (const line of lines) {
    const experienceMatch = line.match(
      /\b(\d{1,3})\s*(?:\+?\s*)?(years?|yrs?)\b/i
    );

    if (experienceMatch) {
      results.push({
        field: "experience",
        data: `${experienceMatch[1]} years`
      });
    }
  }

  // -----------------------------------------------------------
  // 12. Detect remaining meaningful text
  // -----------------------------------------------------------

  const remaining = [];

  for (let i = 0; i < lines.length; i++) {
    if (consumedIndexes.has(i)) {
      continue;
    }

    const line = lines[i];

    if (isJunkLine(line)) {
      continue;
    }

    // Contact information already handled.
    if (containsContactInformation(line)) {
      continue;
    }

    // Very short UI/navigation items.
    if (isLikelyNavigation(line)) {
      continue;
    }

    remaining.push(line);
  }

  // -----------------------------------------------------------
  // 13. Group meaningful remaining content
  // -----------------------------------------------------------

  const meaningful = remaining.filter(line => {
    if (line.length < 4) {
      return false;
    }

    if (isJunkLine(line)) {
      return false;
    }

    return true;
  });

  if (meaningful.length > 0) {
    results.push({
      field: "pending",
      data: uniqueValues(meaningful)
    });
  }
}


// =============================================================
// TEXT NORMALIZATION
// =============================================================

function normalizeText(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t+/g, " ")
    .replace(/[ \u00A0]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}


function cleanLine(line) {
  return String(line)
    .replace(/\s+/g, " ")
    .replace(/^[|•·▪▫►▶→]+/g, "")
    .replace(/[|]+$/g, "")
    .trim();
}


// =============================================================
// JUNK DETECTION
// =============================================================

function isJunkLine(line) {
  const normalized = line
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return true;
  }

  // HTML/code artifacts
  if (
    normalized === "-->" ||
    normalized === "<!--" ||
    normalized === "->"
  ) {
    return true;
  }

  if (
    normalized.includes("<script") ||
    normalized.includes("</script") ||
    normalized.includes("<style") ||
    normalized.includes("</style")
  ) {
    return true;
  }

  // Common footer/navigation junk.
  const junkPatterns = [
    /^copyright\b/,
    /^all rights reserved\b/,
    /^designed by\b/,
    /^developed by\b/,
    /^powered by\b/,
    /^privacy policy$/,
    /^terms and conditions$/,
    /^terms of service$/,
    /^cookie policy$/,
    /^cookies$/,
    /^sitemap$/,
    /^home$/,
    /^menu$/,
    /^login$/,
    /^sign in$/,
    /^sign up$/,
    /^register$/,
    /^gallery$/,
    /^contact us$/,
    /^about us$/,
    /^know more$/,
    /^read more$/,
    /^learn more$/,
    /^view more$/,
    /^view all$/,
    /^book appointment$/,
    /^book now$/,
    /^get started$/,
    /^subscribe$/,
    /^follow us$/,
    /^share$/,
    /^next$/,
    /^previous$/,
    /^close$/,
    /^search$/,
    /^submit$/,
    /^send$/,
    /^loading$/,
    /^javascript$/,
    /^undefined$/,
    /^null$/
  ];

  for (const pattern of junkPatterns) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  // Very obvious CSS / JS garbage.
  if (
    normalized.includes("function(") ||
    normalized.includes("=> {") ||
    normalized.includes("var ") ||
    normalized.includes("const ") ||
    normalized.includes("document.") ||
    normalized.includes("window.")
  ) {
    return true;
  }

  return false;
}


function isJunkField(field) {
  const junk = new Set([
    "id",
    "created_at",
    "updated_at",
    "timestamp",
    "metadata",
    "html",
    "raw_html",
    "scripts",
    "styles",
    "css",
    "javascript",
    "class",
    "class_name"
  ]);

  return junk.has(field);
}


// =============================================================
// NAVIGATION DETECTION
// =============================================================

function isLikelyNavigation(line) {
  const value = line.trim();

  if (value.length > 50) {
    return false;
  }

  const navigationWords = [
    "home",
    "about",
    "services",
    "contact",
    "gallery",
    "blog",
    "menu",
    "login",
    "logout",
    "register",
    "sign in",
    "sign up",
    "book now",
    "book appointment",
    "get started",
    "read more",
    "know more",
    "learn more",
    "view more",
    "view all"
  ];

  return navigationWords.includes(
    value.toLowerCase()
  );
}


// =============================================================
// HEADING DETECTION
// =============================================================

function looksLikeHeading(line) {
  const value = line.trim();

  if (!value) {
    return false;
  }

  if (value.length > 80) {
    return false;
  }

  // A sentence with punctuation is less likely to be heading.
  if (
    value.endsWith(".") &&
    value.split(" ").length > 4
  ) {
    return false;
  }

  // Common heading signal: title-like text.
  const words = value.split(/\s+/);

  if (words.length <= 8) {
    return true;
  }

  return false;
}


function looksLikeLongSentence(line) {
  return (
    line.length > 100 ||
    line.split(/\s+/).length > 18
  );
}


// =============================================================
// CONTACT DETECTION
// =============================================================

function containsContactInformation(value) {
  return (
    extractEmails(value).length > 0 ||
    extractPhones(value).length > 0 ||
    extractUrls(value).length > 0
  );
}


function extractEmails(text) {
  const matches = String(text).match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
  );

  return uniqueValues(matches || []);
}


function extractUrls(text) {
  const matches = String(text).match(
    /https?:\/\/[^\s<>"']+/gi
  );

  return uniqueValues(
    (matches || []).map(url =>
      url.replace(/[),.;]+$/g, "")
    )
  );
}


function extractPhones(text) {
  const matches = String(text).match(
    /(?:\+?\d[\d\s().-]{7,}\d)/g
  );

  if (!matches) {
    return [];
  }

  return uniqueValues(
    matches
      .map(phone =>
        phone
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter(phone => {
        const digits = phone.replace(/\D/g, "");
        return digits.length >= 8 && digits.length <= 15;
      })
  );
}


// =============================================================
// FIELD NAME GENERATION
// =============================================================

function makeFieldName(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  let field = String(value)
    .trim()
    .toLowerCase();

  // Replace symbols with spaces.
  field = field
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  // Convert to snake_case.
  field = field
    .split(/\s+/)
    .filter(Boolean)
    .join("_");

  // Avoid huge field names.
  if (field.length > 100) {
    field = field.slice(0, 100);
  }

  return field;
}


// =============================================================
// VALUE CLEANING
// =============================================================

function cleanValue(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  const text = String(value)
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return null;
  }

  return text;
}


function cleanArray(array) {
  const result = [];

  for (const item of array) {
    if (
      item === null ||
      item === undefined
    ) {
      continue;
    }

    if (
      typeof item === "object"
    ) {
      result.push(item);
      continue;
    }

    const cleaned = cleanValue(item);

    if (
      cleaned !== null &&
      cleaned !== undefined &&
      String(cleaned).trim() !== ""
    ) {
      result.push(cleaned);
    }
  }

  return uniqueValues(result);
}


// =============================================================
// NUMBER PARSING
// =============================================================

function parseNumber(value) {
  const cleaned = String(value)
    .replace(/,/g, "")
    .trim();

  const number = Number(cleaned);

  if (Number.isFinite(number)) {
    return number;
  }

  return value;
}


// =============================================================
// DEDUPLICATION
// =============================================================

function uniqueValues(values) {
  const seen = new Set();
  const output = [];

  for (const value of values || []) {
    const key =
      typeof value === "object"
        ? JSON.stringify(value)
        : String(value)
            .trim()
            .toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(value);
  }

  return output;
}


// =============================================================
// RESULT CLEANING
// =============================================================

function cleanResults(results) {
  const grouped = new Map();

  for (const item of results) {
    if (
      !item ||
      !item.field
    ) {
      continue;
    }

    const field = makeFieldName(item.field);

    if (!field) {
      continue;
    }

    if (
      item.data === null ||
      item.data === undefined
    ) {
      continue;
    }

    const cleanedData =
      cleanValueDeep(item.data);

    if (
      cleanedData === null ||
      cleanedData === undefined
    ) {
      continue;
    }

    if (!grouped.has(field)) {
      grouped.set(field, []);
    }

    grouped.get(field).push(cleanedData);
  }

  const output = [];

  for (const [field, values] of grouped.entries()) {
    // ---------------------------------------------------------
    // Merge multiple values for the same field.
    // ---------------------------------------------------------

    if (field === "pending") {
      const flattened = [];

      for (const value of values) {
        if (Array.isArray(value)) {
          flattened.push(...value);
        } else {
          flattened.push(value);
        }
      }

      const unique = uniqueValues(flattened);

      if (unique.length > 0) {
        output.push({
          field,
          data: unique
        });
      }

      continue;
    }

    // If there is only one value, keep it simple.
    if (values.length === 1) {
      output.push({
        field,
        data: values[0]
      });

      continue;
    }

    // Multiple values.
    const flattened = [];

    for (const value of values) {
      if (Array.isArray(value)) {
        flattened.push(...value);
      } else {
        flattened.push(value);
      }
    }

    output.push({
      field,
      data: uniqueValues(flattened)
    });
  }

  return output;
}


function cleanValueDeep(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => cleanValueDeep(item))
      .filter(
        item =>
          item !== null &&
          item !== undefined &&
          item !== ""
      );
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const result = {};

    for (const [key, val] of Object.entries(value)) {
      const cleaned = cleanValueDeep(val);

      if (
        cleaned !== null &&
        cleaned !== undefined &&
        cleaned !== ""
      ) {
        result[key] = cleaned;
      }
    }

    return result;
  }

  if (typeof value === "string") {
    return cleanValue(value);
  }

  return value;
}


// =============================================================
// SUPABASE HELPERS
// =============================================================

function supabaseHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization:
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
}


// =============================================================
// UPDATE business_data STATUS
// =============================================================

async function updateBusinessDataStatus(
  env,
  id,
  status,
  errorMessage
) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data?id=eq.${encodeURIComponent(id)}`;

  const body = {
    ai_status: status,
    ai_error: errorMessage || null,
    updated_at: new Date().toISOString()
  };

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(env),
      Prefer: "return=minimal"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();

    console.error(
      "Failed to update business_data status:",
      errorText
    );
  }
}


// =============================================================
// UPSERT BUSINESS KNOWLEDGE
// =============================================================

async function upsertKnowledge(
  env,
  applicationId,
  field,
  data,
  sourceUrl
) {
  // -----------------------------------------------------------
  // 1. Find existing field
  // -----------------------------------------------------------

  const selectUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}` +
    `&select=*`;

  const selectResponse = await fetch(selectUrl, {
    method: "GET",
    headers: supabaseHeaders(env)
  });

  if (!selectResponse.ok) {
    const errorText =
      await selectResponse.text();

    throw new Error(
      `Failed to find business_knowledge row: ${errorText}`
    );
  }

  const existingRows =
    await selectResponse.json();

  // -----------------------------------------------------------
  // 2. Create new row
  // -----------------------------------------------------------

  if (
    !Array.isArray(existingRows) ||
    existingRows.length === 0
  ) {
    const now =
      new Date().toISOString();

    const insertBody = {
      application_id: applicationId,
      field,
      data,
      created_at: now,
      updated_at: now,
      source_urls: sourceUrl
        ? [sourceUrl]
        : []
    };

    const insertUrl =
      `${env.SUPABASE_URL}/rest/v1/business_knowledge`;

    const insertResponse = await fetch(
      insertUrl,
      {
        method: "POST",
        headers: {
          ...supabaseHeaders(env),
          Prefer: "return=minimal"
        },
        body: JSON.stringify(insertBody)
      }
    );

    if (!insertResponse.ok) {
      const errorText =
        await insertResponse.text();

      throw new Error(
        `Failed to insert business_knowledge: ${errorText}`
      );
    }

    return;
  }

  // -----------------------------------------------------------
  // 3. Update existing row
  // -----------------------------------------------------------

  const existing =
    existingRows[0];

  const mergedData =
    mergeKnowledgeData(
      existing.data,
      data
    );

  const existingUrls =
    Array.isArray(existing.source_urls)
      ? existing.source_urls
      : [];

  const mergedUrls =
    uniqueValues([
      ...existingUrls,
      ...(sourceUrl ? [sourceUrl] : [])
    ]);

  const updateBody = {
    data: mergedData,
    source_urls: mergedUrls,
    updated_at:
      new Date().toISOString()
  };

  const updateUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?id=eq.${encodeURIComponent(existing.id)}`;

  const updateResponse = await fetch(
    updateUrl,
    {
      method: "PATCH",
      headers: {
        ...supabaseHeaders(env),
        Prefer: "return=minimal"
      },
      body: JSON.stringify(updateBody)
    }
  );

  if (!updateResponse.ok) {
    const errorText =
      await updateResponse.text();

    throw new Error(
      `Failed to update business_knowledge: ${errorText}`
    );
  }
}


// =============================================================
// MERGE KNOWLEDGE DATA
// =============================================================

function mergeKnowledgeData(
  oldData,
  newData
) {
  // -----------------------------------------------------------
  // Arrays
  // -----------------------------------------------------------

  if (
    Array.isArray(oldData) &&
    Array.isArray(newData)
  ) {
    return uniqueValues([
      ...oldData,
      ...newData
    ]);
  }

  // -----------------------------------------------------------
  // Objects
  // -----------------------------------------------------------

  if (
    oldData &&
    typeof oldData === "object" &&
    !Array.isArray(oldData) &&
    newData &&
    typeof newData === "object" &&
    !Array.isArray(newData)
  ) {
    return {
      ...oldData,
      ...newData
    };
  }

  // -----------------------------------------------------------
  // Scalar values
  //
  // Newer information replaces older information.
  // -----------------------------------------------------------

  return newData;
}


// =============================================================
// JSON RESPONSE
// =============================================================

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
        }
