/**
 * Reportli AI
 * AI Business Knowledge Worker
 *
 * Purpose:
 *   Convert raw business_data rows into normalized business_knowledge.
 *
 * IMPORTANT:
 *   - No AI
 *   - No website scraping
 *   - No business-specific fields
 *   - No hardcoded business vocabulary
 *   - Generic structural/pattern-based extraction only
 *
 * Flow:
 *
 * business_data INSERT
 *        ↓
 * Supabase Database Webhook
 *        ↓
 * this Worker
 *        ↓
 * generic parser
 *        ↓
 * business_knowledge
 */

// ============================================================
// CONFIGURATION
// ============================================================

const MAX_TEXT_LENGTH = 50000;
const MAX_ARRAY_ITEMS = 500;
const MAX_OBJECT_KEYS = 500;
const MAX_PENDING_ITEMS = 100;

const JUNK_EXACT = new Set([
  "skip to content",
  "skip to footer",
  "skip to sidebar",
  "menu",
  "close",
  "search",
  "submit",
  "cancel",
  "cancel reply",
  "leave a comment",
  "reply",
  "read more",
  "learn more",
  "click here",
  "back to top",
  "previous",
  "next",
  "home",
  "privacy policy",
  "terms and conditions"
]);

const JUNK_PATTERNS = [
  /^skip to /i,
  /^leave a comment$/i,
  /^cancel reply$/i,
  /^search$/i,
  /^close$/i,
  /^menu$/i,
  /^read more$/i,
  /^learn more$/i,
  /^click here$/i
];

// ============================================================
// MAIN ENTRY
// ============================================================

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json(
        {
          success: false,
          error: "POST required"
        },
        405
      );
    }

    try {
      const payload = await request.json();

      console.log(
        "Webhook received:",
        JSON.stringify(payload).slice(0, 5000)
      );

      // ------------------------------------------------------
      // Extract the actual business_data record.
      // Supports:
      //
      // 1. Direct Supabase webhook payload
      // 2. { record: {...} }
      // 3. { new_record: {...} }
      // 4. { data: { record: {...} } }
      // 5. { data: { new_record: {...} } }
      // ------------------------------------------------------

      const record = extractRecord(payload);

      if (!record) {
        return json(
          {
            success: false,
            error: "Could not find business_data record in webhook payload"
          },
          400
        );
      }

      const applicationId = record.application_id;
      const sourceUrl = cleanString(record.source_url);

      if (!applicationId) {
        return json(
          {
            success: false,
            error: "application_id is missing"
          },
          400
        );
      }

      if (!record.data) {
        await updateBusinessDataStatus(
          env,
          record.id,
          "error",
          "data is missing"
        );

        return json(
          {
            success: false,
            error: "business_data.data is missing"
          },
          400
        );
      }

      // ------------------------------------------------------
      // Parse raw data
      // ------------------------------------------------------

      const result = parseGenericData(record.data);

      console.log(
        "Parser result:",
        JSON.stringify({
          extracted: result.extracted.length,
          pending: result.pending.length,
          removed: result.removed
        })
      );

      // ------------------------------------------------------
      // Save extracted knowledge
      // ------------------------------------------------------

      let savedCount = 0;

      for (const item of result.extracted) {
        const saved = await upsertKnowledge(
          env,
          applicationId,
          item.field,
          item.data,
          sourceUrl
        );

        if (saved) {
          savedCount++;
        }
      }

      // ------------------------------------------------------
      // Save meaningful unknown content as pending
      // ------------------------------------------------------

      for (const item of result.pending.slice(0, MAX_PENDING_ITEMS)) {
        const saved = await savePending(
          env,
          applicationId,
          item,
          sourceUrl
        );

        if (saved) {
          savedCount++;
        }
      }

      // ------------------------------------------------------
      // Mark source row as completed
      // ------------------------------------------------------

      if (record.id) {
        await updateBusinessDataStatus(
          env,
          record.id,
          "completed",
          null
        );
      }

      return json({
        success: true,
        application_id: applicationId,
        source_url: sourceUrl,
        extracted_count: result.extracted.length,
        pending_count: result.pending.length,
        removed_count: result.removed,
        saved_count: savedCount
      });
    } catch (error) {
      console.error("Worker error:", error);

      return json(
        {
          success: false,
          error: error?.message || String(error)
        },
        500
      );
    }
  }
};


// ============================================================
// WEBHOOK RECORD EXTRACTION
// ============================================================

function extractRecord(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  // Direct Supabase Database Webhook payload
  if (
    payload.id &&
    payload.application_id &&
    payload.field &&
    Object.prototype.hasOwnProperty.call(payload, "data")
  ) {
    return payload;
  }

  // Common wrappers
  if (payload.record && typeof payload.record === "object") {
    return payload.record;
  }

  if (
    payload.new_record &&
    typeof payload.new_record === "object"
  ) {
    return payload.new_record;
  }

  if (
    payload.data &&
    typeof payload.data === "object" &&
    payload.data.record &&
    typeof payload.data.record === "object"
  ) {
    return payload.data.record;
  }

  if (
    payload.data &&
    typeof payload.data === "object" &&
    payload.data.new_record &&
    typeof payload.data.new_record === "object"
  ) {
    return payload.data.new_record;
  }

  return null;
}


// ============================================================
// GENERIC PARSER
// ============================================================

function parseGenericData(input) {
  const extracted = [];
  const pending = [];

  const state = {
    extractedKeys: new Set(),
    seenText: new Set(),
    removed: 0,
    pendingCount: 0
  };

  walkValue(
    input,
    [],
    extracted,
    pending,
    state
  );

  return {
    extracted: deduplicateExtracted(extracted),
    pending: deduplicatePending(pending),
    removed: state.removed
  };
}


// ============================================================
// RECURSIVE VALUE WALKER
// ============================================================

function walkValue(
  value,
  path,
  extracted,
  pending,
  state
) {
  if (value === null || value === undefined) {
    return;
  }

  // ----------------------------------------------------------
  // STRING
  // ----------------------------------------------------------

  if (typeof value === "string") {
    processString(
      value,
      path,
      extracted,
      pending,
      state
    );

    return;
  }

  // ----------------------------------------------------------
  // NUMBER
  // ----------------------------------------------------------

  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    if (path.length > 0) {
      const field = normalizeFieldName(path[path.length - 1]);

      if (field) {
        addExtracted(
          extracted,
          field,
          value,
          state
        );
      }
    }

    return;
  }

  // ----------------------------------------------------------
  // BOOLEAN
  // ----------------------------------------------------------

  if (typeof value === "boolean") {
    if (path.length > 0) {
      const field = normalizeFieldName(path[path.length - 1]);

      if (field) {
        addExtracted(
          extracted,
          field,
          value,
          state
        );
      }
    }

    return;
  }

  // ----------------------------------------------------------
  // ARRAY
  // ----------------------------------------------------------

  if (Array.isArray(value)) {
    processArray(
      value,
      path,
      extracted,
      pending,
      state
    );

    return;
  }

  // ----------------------------------------------------------
  // OBJECT
  // ----------------------------------------------------------

  if (typeof value === "object") {
    processObject(
      value,
      path,
      extracted,
      pending,
      state
    );
  }
}


// ============================================================
// OBJECT PROCESSING
// ============================================================

function processObject(
  object,
  path,
  extracted,
  pending,
  state
) {
  const keys = Object.keys(object);

  for (
    const key of keys.slice(0, MAX_OBJECT_KEYS)
  ) {
    const value = object[key];

    const normalizedKey = normalizeFieldName(key);

    if (!normalizedKey) {
      walkValue(
        value,
        path,
        extracted,
        pending,
        state
      );

      continue;
    }

    // --------------------------------------------------------
    // Preserve structured key/value relationships.
    // This is generic and does not know what the key means.
    // --------------------------------------------------------

    if (isPrimitive(value)) {
      if (
        typeof value === "string" &&
        isJunkText(value)
      ) {
        state.removed++;
        continue;
      }

      addExtracted(
        extracted,
        normalizedKey,
        normalizePrimitive(value),
        state
      );

      continue;
    }

    if (Array.isArray(value)) {
      const cleanedArray = cleanArray(value);

      if (cleanedArray.length > 0) {
        addExtracted(
          extracted,
          normalizedKey,
          cleanedArray,
          state
        );
      }

      // Also inspect nested structures.
      for (
        const item of value.slice(0, MAX_ARRAY_ITEMS)
      ) {
        if (
          item &&
          typeof item === "object"
        ) {
          walkValue(
            item,
            [...path, normalizedKey],
            extracted,
            pending,
            state
          );
        }
      }

      continue;
    }

    if (
      value &&
      typeof value === "object"
    ) {
      // Preserve the object itself.
      const cleanedObject = cleanObject(value);

      if (
        cleanedObject &&
        Object.keys(cleanedObject).length > 0
      ) {
        addExtracted(
          extracted,
          normalizedKey,
          cleanedObject,
          state
        );
      }

      // Continue recursively.
      walkValue(
        value,
        [...path, normalizedKey],
        extracted,
        pending,
        state
      );
    }
  }
}


// ============================================================
// ARRAY PROCESSING
// ============================================================

function processArray(
  array,
  path,
  extracted,
  pending,
  state
) {
  const cleaned = cleanArray(array);

  if (cleaned.length === 0) {
    return;
  }

  // If an array belongs to a known structural key,
  // preserve that relationship.
  if (path.length > 0) {
    const field = normalizeFieldName(
      path[path.length - 1]
    );

    if (field) {
      addExtracted(
        extracted,
        field,
        cleaned,
        state
      );
    }
  }

  // Inspect nested objects.
  for (
    const item of array.slice(0, MAX_ARRAY_ITEMS)
  ) {
    if (
      item &&
      typeof item === "object"
    ) {
      walkValue(
        item,
        path,
        extracted,
        pending,
        state
      );
    }
  }
}


// ============================================================
// STRING PROCESSING
// ============================================================

function processString(
  value,
  path,
  extracted,
  pending,
  state
) {
  let text = normalizeText(value);

  if (!text) {
    return;
  }

  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH);
  }

  // Remove obvious boilerplate.
  if (isJunkText(text)) {
    state.removed++;
    return;
  }

  // Deduplicate exact repeated text.
  const fingerprint = normalizeFingerprint(text);

  if (fingerprint) {
    if (state.seenText.has(fingerprint)) {
      state.removed++;
      return;
    }

    state.seenText.add(fingerprint);
  }

  // ----------------------------------------------------------
  // If this string belongs to an explicit object key,
  // preserve that relationship.
  // ----------------------------------------------------------

  if (path.length > 0) {
    const field = normalizeFieldName(
      path[path.length - 1]
    );

    if (field) {
      addExtracted(
        extracted,
        field,
        text,
        state
      );

      return;
    }
  }

  // ----------------------------------------------------------
  // Try generic structured text.
  // Example:
  //
  // "Something: Value"
  // "Something - Value"
  // ----------------------------------------------------------

  const labeled = parseLabeledText(text);

  if (labeled) {
    addExtracted(
      extracted,
      labeled.field,
      labeled.data,
      state
    );

    return;
  }

  // ----------------------------------------------------------
  // Try generic heading + list / block structures.
  // ----------------------------------------------------------

  const blocks = splitMeaningfulBlocks(text);

  if (blocks.length > 1) {
    const structured = parseBlocks(blocks);

    if (structured.length > 0) {
      for (const item of structured) {
        addExtracted(
          extracted,
          item.field,
          item.data,
          state
        );
      }

      return;
    }
  }

  // ----------------------------------------------------------
  // Recognize values by format.
  // The Worker does NOT know the business category.
  // ----------------------------------------------------------

  const detected = detectGenericValue(text);

  if (detected) {
    addExtracted(
      extracted,
      detected.field,
      detected.data,
      state
    );

    return;
  }

  // ----------------------------------------------------------
  // Meaningful content that cannot safely be classified.
  // ----------------------------------------------------------

  if (isMeaningfulText(text)) {
    pending.push({
      text,
      path
    });

    state.pendingCount++;

    return;
  }

  state.removed++;
}


// ============================================================
// GENERIC LABELED TEXT
// ============================================================

function parseLabeledText(text) {
  // Only treat a string as a label/value relationship
  // when the structure is reasonably clear.

  const colonMatch = text.match(
    /^([^:\n]{1,100})\s*:\s*(.{1,10000})$/s
  );

  if (colonMatch) {
    const label = cleanLabel(colonMatch[1]);
    const value = normalizeText(colonMatch[2]);

    if (
      isValidGenericLabel(label) &&
      value
    ) {
      return {
        field: normalizeFieldName(label),
        data: value
      };
    }
  }

  const dashMatch = text.match(
    /^([^-–—\n]{1,100})\s*[-–—]\s*(.{1,10000})$/s
  );

  if (dashMatch) {
    const label = cleanLabel(dashMatch[1]);
    const value = normalizeText(dashMatch[2]);

    if (
      isValidGenericLabel(label) &&
      value
    ) {
      return {
        field: normalizeFieldName(label),
        data: value
      };
    }
  }

  return null;
}


// ============================================================
// GENERIC BLOCK PARSER
// ============================================================

function parseBlocks(blocks) {
  const result = [];

  for (let i = 0; i < blocks.length; i++) {
    const current = blocks[i];

    if (!isLikelyHeading(current)) {
      continue;
    }

    const next = blocks[i + 1];

    if (!next) {
      continue;
    }

    // Heading followed by a list-like block.
    if (looksLikeList(next)) {
      result.push({
        field: normalizeFieldName(current),
        data: parseList(next)
      });

      continue;
    }

    // Heading followed by meaningful content.
    if (
      isMeaningfulText(next) &&
      next.length <= MAX_TEXT_LENGTH
    ) {
      result.push({
        field: normalizeFieldName(current),
        data: next
      });
    }
  }

  return result.filter(
    item =>
      item.field &&
      item.data !== undefined &&
      item.data !== null
  );
}


// ============================================================
// GENERIC FORMAT DETECTION
// ============================================================

function detectGenericValue(text) {
  // ----------------------------------------------------------
  // Email
  // ----------------------------------------------------------

  if (looksLikeEmail(text)) {
    return {
      field: "email",
      data: text
    };
  }

  // ----------------------------------------------------------
  // URL
  // ----------------------------------------------------------

  if (looksLikeUrl(text)) {
    return {
      field: "url",
      data: text
    };
  }

  // ----------------------------------------------------------
  // Phone
  // ----------------------------------------------------------

  if (looksLikePhone(text)) {
    return {
      field: "phone",
      data: text
    };
  }

  // ----------------------------------------------------------
  // Date
  // ----------------------------------------------------------

  if (looksLikeDate(text)) {
    return {
      field: "date",
      data: text
    };
  }

  return null;
}


// ============================================================
// ARRAY CLEANING
// ============================================================

function cleanArray(array) {
  const result = [];
  const fingerprints = new Set();

  for (
    const item of array.slice(0, MAX_ARRAY_ITEMS)
  ) {
    if (item === null || item === undefined) {
      continue;
    }

    if (typeof item === "string") {
      const value = normalizeText(item);

      if (!value || isJunkText(value)) {
        continue;
      }

      const fingerprint =
        normalizeFingerprint(value);

      if (fingerprints.has(fingerprint)) {
        continue;
      }

      fingerprints.add(fingerprint);
      result.push(value);

      continue;
    }

    if (
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      result.push(item);
      continue;
    }

    if (
      typeof item === "object"
    ) {
      const cleaned = cleanObject(item);

      if (
        cleaned &&
        Object.keys(cleaned).length > 0
      ) {
        result.push(cleaned);
      }
    }
  }

  return result;
}


// ============================================================
// OBJECT CLEANING
// ============================================================

function cleanObject(object) {
  const output = {};

  for (
    const key of Object.keys(object).slice(
      0,
      MAX_OBJECT_KEYS
    )
  ) {
    const value = object[key];

    if (
      typeof value === "string"
    ) {
      const cleaned = normalizeText(value);

      if (
        !cleaned ||
        isJunkText(cleaned)
      ) {
        continue;
      }

      output[key] =
        cleaned.slice(0, MAX_TEXT_LENGTH);

      continue;
    }

    if (
      Array.isArray(value)
    ) {
      const cleanedArray =
        cleanArray(value);

      if (cleanedArray.length > 0) {
        output[key] = cleanedArray;
      }

      continue;
    }

    if (
      value &&
      typeof value === "object"
    ) {
      const cleanedObject =
        cleanObject(value);

      if (
        cleanedObject &&
        Object.keys(cleanedObject).length > 0
      ) {
        output[key] = cleanedObject;
      }

      continue;
    }

    if (
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      output[key] = value;
    }
  }

  return output;
}


// ============================================================
// TEXT UTILITIES
// ============================================================

function normalizeText(value) {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


function cleanString(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return normalizeText(value);
}


function normalizeFingerprint(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}


// ============================================================
// FIELD NORMALIZATION
// ============================================================

function normalizeFieldName(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  let field = String(value)
    .trim()
    .toLowerCase();

  field = field
    .replace(/['"`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!field) {
    return "";
  }

  return field.slice(0, 150);
}


function cleanLabel(value) {
  return normalizeText(value)
    .replace(/^[-–—:]+/, "")
    .replace(/[-–—:]+$/, "")
    .trim();
}


function isValidGenericLabel(label) {
  if (!label) {
    return false;
  }

  if (label.length < 2) {
    return false;
  }

  if (label.length > 100) {
    return false;
  }

  if (JUNK_EXACT.has(
    label.toLowerCase()
  )) {
    return false;
  }

  // Avoid treating a whole sentence as a field name.
  const words = label.split(/\s+/);

  if (words.length > 12) {
    return false;
  }

  return true;
}


// ============================================================
// JUNK DETECTION
// ============================================================

function isJunkText(text) {
  const normalized =
    normalizeFingerprint(text);

  if (!normalized) {
    return true;
  }

  if (JUNK_EXACT.has(normalized)) {
    return true;
  }

  for (
    const pattern of JUNK_PATTERNS
  ) {
    if (pattern.test(text.trim())) {
      return true;
    }
  }

  return false;
}


// ============================================================
// MEANINGFUL TEXT DETECTION
// ============================================================

function isMeaningfulText(text) {
  const value = normalizeText(text);

  if (!value) {
    return false;
  }

  if (value.length < 3) {
    return false;
  }

  if (isJunkText(value)) {
    return false;
  }

  // Ignore strings consisting almost entirely
  // of symbols/punctuation.
  const letters =
    (value.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || [])
      .length;

  if (
    letters === 0 &&
    !/\d/.test(value)
  ) {
    return false;
  }

  return true;
}


// ============================================================
// HEADING DETECTION
// ============================================================

function isLikelyHeading(text) {
  const value = normalizeText(text);

  if (!value) {
    return false;
  }

  if (value.length > 180) {
    return false;
  }

  if (value.endsWith(".")) {
    return false;
  }

  if (value.endsWith("?")) {
    return false;
  }

  if (value.endsWith("!")) {
    return false;
  }

  const words = value.split(/\s+/);

  if (words.length > 15) {
    return false;
  }

  return true;
}


// ============================================================
// LIST DETECTION
// ============================================================

function looksLikeList(text) {
  const lines = String(text)
    .split(/\n/)
    .map(x => normalizeText(x))
    .filter(Boolean);

  if (lines.length < 2) {
    return false;
  }

  let listLines = 0;

  for (const line of lines) {
    if (
      /^[-*•]\s+/.test(line) ||
      /^\d+[.)]\s+/.test(line)
    ) {
      listLines++;
    }
  }

  return listLines >= 2;
}


function parseList(text) {
  const lines = String(text)
    .split(/\n/)
    .map(x => normalizeText(x))
    .filter(Boolean);

  const result = [];

  for (const line of lines) {
    const cleaned = line
      .replace(/^[-*•]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();

    if (
      cleaned &&
      !isJunkText(cleaned)
    ) {
      result.push(cleaned);
    }
  }

  return result;
}


// ============================================================
// BLOCK SPLITTING
// ============================================================

function splitMeaningfulBlocks(text) {
  return String(text)
    .split(/\n{2,}|\n/)
    .map(x => normalizeText(x))
    .filter(x => isMeaningfulText(x))
    .slice(0, 500);
}


// ============================================================
// GENERIC FORMAT HELPERS
// ============================================================

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    value.trim()
  );
}


function looksLikeUrl(value) {
  try {
    const url = new URL(value.trim());

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}


function looksLikePhone(value) {
  const cleaned = value
    .replace(/[^\d+]/g, "");

  const digits =
    cleaned.replace(/\D/g, "");

  return (
    digits.length >= 7 &&
    digits.length <= 15
  );
}


function looksLikeDate(value) {
  const text = value.trim();

  // ISO-style date
  if (
    /^\d{4}-\d{1,2}-\d{1,2}$/.test(text)
  ) {
    return true;
  }

  // Common numeric date
  if (
    /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text)
  ) {
    return true;
  }

  // Month-name date
  if (
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(,\s*\d{4})?$/i.test(
      text
    )
  ) {
    return true;
  }

  if (
    /^\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i.test(
      text
    )
  ) {
    return true;
  }

  return false;
}


// ============================================================
// TYPE HELPERS
// ============================================================

function isPrimitive(value) {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}


function normalizePrimitive(value) {
  if (typeof value === "string") {
    return normalizeText(value);
  }

  return value;
}


// ============================================================
// EXTRACTED DATA MANAGEMENT
// ============================================================

function addExtracted(
  extracted,
  field,
  data,
  state
) {
  if (!field) {
    return;
  }

  if (
    data === undefined ||
    data === null
  ) {
    return;
  }

  if (
    typeof data === "string" &&
    !data.trim()
  ) {
    return;
  }

  const existing =
    extracted.find(
      item => item.field === field
    );

  if (!existing) {
    extracted.push({
      field,
      data
    });

    state.extractedKeys.add(field);
    return;
  }

  existing.data =
    mergeValues(
      existing.data,
      data
    );
}


function mergeValues(oldValue, newValue) {
  if (
    Array.isArray(oldValue) &&
    Array.isArray(newValue)
  ) {
    return uniqueValues([
      ...oldValue,
      ...newValue
    ]);
  }

  if (
    isPlainObject(oldValue) &&
    isPlainObject(newValue)
  ) {
    return {
      ...oldValue,
      ...newValue
    };
  }

  if (
    oldValue === newValue
  ) {
    return oldValue;
  }

  return newValue;
}


function uniqueValues(values) {
  const output = [];
  const seen = new Set();

  for (const value of values) {
    const key =
      typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(value);
  }

  return output;
}


function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}


// ============================================================
// DEDUPLICATION
// ============================================================

function deduplicateExtracted(items) {
  const map = new Map();

  for (const item of items) {
    if (!item.field) {
      continue;
    }

    if (!map.has(item.field)) {
      map.set(item.field, {
        field: item.field,
        data: item.data
      });

      continue;
    }

    const existing =
      map.get(item.field);

    existing.data =
      mergeValues(
        existing.data,
        item.data
      );
  }

  return [...map.values()];
}


function deduplicatePending(items) {
  const output = [];
  const seen = new Set();

  for (const item of items) {
    const fingerprint =
      normalizeFingerprint(item.text);

    if (!fingerprint) {
      continue;
    }

    if (seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);

    output.push({
      text: item.text,
      path: item.path
    });
  }

  return output;
}


// ============================================================
// SUPABASE HELPERS
// ============================================================

function supabaseHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization:
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
}


function supabaseUrl(env, table) {
  return `${env.SUPABASE_URL}/rest/v1/${table}`;
}


// ============================================================
// SAVE / UPDATE BUSINESS KNOWLEDGE
// ============================================================

async function upsertKnowledge(
  env,
  applicationId,
  field,
  data,
  sourceUrl
) {
  if (!field) {
    return false;
  }

  const headers =
    supabaseHeaders(env);

  // ----------------------------------------------------------
  // Find existing knowledge for:
  //
  // application_id + field
  // ----------------------------------------------------------

  const query =
    `${supabaseUrl(
      env,
      "business_knowledge"
    )}?application_id=eq.${encodeURIComponent(
      applicationId
    )}&field=eq.${encodeURIComponent(
      field
    )}&select=id,data,source_urls`;

  const findResponse =
    await fetch(query, {
      method: "GET",
      headers
    });

  if (!findResponse.ok) {
    throw new Error(
      `Failed to query business_knowledge: ${await findResponse.text()}`
    );
  }

  const existing =
    await findResponse.json();

  const now =
    new Date().toISOString();

  const existingRow =
    existing[0];

  if (existingRow) {
    const mergedData =
      mergeValues(
        existingRow.data,
        data
      );

    const sourceUrls =
      mergeSourceUrls(
        existingRow.source_urls,
        sourceUrl
      );

    const updateResponse =
      await fetch(
        `${supabaseUrl(
          env,
          "business_knowledge"
        )}?id=eq.${encodeURIComponent(
          existingRow.id
        )}`,
        {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=minimal"
          },
          body: JSON.stringify({
            data: mergedData,
            source_urls: sourceUrls,
            updated_at: now
          })
        }
      );

    if (!updateResponse.ok) {
      throw new Error(
        `Failed to update business_knowledge: ${await updateResponse.text()}`
      );
    }

    return true;
  }

  // ----------------------------------------------------------
  // Insert new knowledge
  // ----------------------------------------------------------

  const insertResponse =
    await fetch(
      supabaseUrl(
        env,
        "business_knowledge"
      ),
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          application_id: applicationId,
          field,
          data,
          source_urls:
            sourceUrl
              ? [sourceUrl]
              : [],
          created_at: now,
          updated_at: now
        })
      }
    );

  if (!insertResponse.ok) {
    const errorText =
      await insertResponse.text();

    // Possible race:
    // another webhook created the same field.
    if (
      insertResponse.status === 409
    ) {
      return await upsertKnowledge(
        env,
        applicationId,
        field,
        data,
        sourceUrl
      );
    }

    throw new Error(
      `Failed to insert business_knowledge: ${errorText}`
    );
  }

  return true;
}


// ============================================================
// PENDING DATA
// ============================================================

async function savePending(
  env,
  applicationId,
  item,
  sourceUrl
) {
  const pendingData = {
    text: item.text,
    path: item.path,
    reason:
      "Meaningful content detected but no reliable generic field relationship could be determined."
  };

  return await upsertKnowledge(
    env,
    applicationId,
    "pending",
    pendingData,
    sourceUrl
  );
}


// ============================================================
// SOURCE URL MERGING
// ============================================================

function mergeSourceUrls(
  existing,
  sourceUrl
) {
  const urls = [];

  if (Array.isArray(existing)) {
    urls.push(...existing);
  }

  if (sourceUrl) {
    urls.push(sourceUrl);
  }

  return [
    ...new Set(
      urls
        .filter(Boolean)
        .map(x => String(x))
    )
  ];
}


// ============================================================
// UPDATE BUSINESS_DATA STATUS
// ============================================================

async function updateBusinessDataStatus(
  env,
  rowId,
  status,
  errorMessage
) {
  if (!rowId) {
    return;
  }

  const body = {
    ai_status: status,
    ai_error:
      errorMessage || null,
    updated_at:
      new Date().toISOString()
  };

  const response =
    await fetch(
      `${supabaseUrl(
        env,
        "business_data"
      )}?id=eq.${encodeURIComponent(
        rowId
      )}`,
      {
        method: "PATCH",
        headers: {
          ...supabaseHeaders(env),
          Prefer: "return=minimal"
        },
        body: JSON.stringify(body)
      }
    );

  if (!response.ok) {
    console.error(
      "Failed to update business_data status:",
      await response.text()
    );
  }
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type":
          "application/json"
      }
    }
  );
  }
