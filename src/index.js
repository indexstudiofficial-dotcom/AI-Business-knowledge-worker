/**
 * Reportli AI
 * Generic Business Knowledge Worker
 *
 * IMPORTANT:
 * - NO AI
 * - NO Sarvam
 * - NO website scraping
 * - NO business-specific field dictionary
 * - NO adjacent-line field/value guessing
 *
 * Flow:
 *
 * business_data INSERT
 *       ↓
 * Supabase Database Webhook
 *       ↓
 * fetch ALL business_data rows for application
 *       ↓
 * parse structured data safely
 *       ↓
 * remove obvious repeated/layout blocks structurally
 *       ↓
 * extract only relationships supported by the source structure
 *       ↓
 * business_knowledge
 */

const MAX_TEXT_CHARS = 50000;
const MAX_BLOCKS_PER_PAGE = 500;
const MAX_PENDING_ITEMS = 100;
const MAX_PENDING_CHARS = 6000;
const MAX_KNOWLEDGE_ITEMS = 500;

// ------------------------------------------------------------
// ENTRY POINT
// ------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json({
        ok: false,
        error: "POST only"
      }, 405);
    }

    try {
      const payload = await request.json();

      const record = unwrapRecord(payload);

      if (!record) {
        throw new Error("Could not find business_data record in webhook payload.");
      }

      if (!record.application_id) {
        throw new Error("application_id is missing.");
      }

      console.log(
        JSON.stringify({
          event: "knowledge_worker_started",
          application_id: record.application_id,
          business_data_id: record.id,
          source_url: record.source_url || null
        })
      );

      // --------------------------------------------------------
      // IMPORTANT:
      // Read ALL business_data for the application.
      //
      // We do NOT process only the webhook row because:
      // - navigation repeats across pages
      // - footer repeats across pages
      // - blog pages repeat common layout
      // - deduplication needs the entire application dataset
      // --------------------------------------------------------

      const rows = await fetchAllBusinessData(
        env,
        record.application_id
      );

      if (!rows.length) {
        throw new Error(
          `No business_data rows found for application ${record.application_id}`
        );
      }

      console.log(
        JSON.stringify({
          event: "business_data_loaded",
          application_id: record.application_id,
          row_count: rows.length
        })
      );

      // --------------------------------------------------------
      // Build page groups
      // --------------------------------------------------------

      const pages = groupRowsIntoPages(rows);

      // --------------------------------------------------------
      // Extract knowledge
      // --------------------------------------------------------

      const knowledge = extractKnowledge(pages);

      if (!knowledge.length) {
        throw new Error(
          "Parser produced zero knowledge records. Existing knowledge was not deleted."
        );
      }

      if (knowledge.length > MAX_KNOWLEDGE_ITEMS) {
        knowledge.splice(MAX_KNOWLEDGE_ITEMS);
      }

      console.log(
        JSON.stringify({
          event: "knowledge_extracted",
          application_id: record.application_id,
          page_count: pages.length,
          knowledge_count: knowledge.length
        })
      );

      // --------------------------------------------------------
      // Replace application's knowledge ONLY after extraction
      // succeeded.
      // --------------------------------------------------------

      await deleteApplicationKnowledge(
        env,
        record.application_id
      );

      await insertKnowledge(
        env,
        record.application_id,
        knowledge
      );

      // --------------------------------------------------------
      // Mark source rows completed
      // --------------------------------------------------------

      await markRowsCompleted(
        env,
        rows
      );

      console.log(
        JSON.stringify({
          event: "knowledge_worker_completed",
          application_id: record.application_id,
          knowledge_count: knowledge.length
        })
      );

      return json({
        ok: true,
        application_id: record.application_id,
        pages: pages.length,
        knowledge_records: knowledge.length
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "knowledge_worker_error",
          error: error?.message || String(error)
        })
      );

      // Try to mark the webhook row as failed.
      try {
        const payload = await safeCloneRequestBody(request);

        if (payload) {
          const record = unwrapRecord(payload);

          if (record?.id) {
            await markRowError(
              env,
              record.id,
              error?.message || String(error)
            );
          }
        }
      } catch (_) {
        // Do not hide the original error.
      }

      return json(
        {
          ok: false,
          error: error?.message || String(error)
        },
        500
      );
    }
  }
};


// ============================================================
// WEBHOOK PARSING
// ============================================================

function unwrapRecord(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  // Supabase Database Webhook confirmed shape.
  if (
    payload.id &&
    payload.application_id &&
    payload.field !== undefined
  ) {
    return payload;
  }

  // Support common wrappers too.
  if (
    payload.record &&
    payload.record.id &&
    payload.record.application_id
  ) {
    return payload.record;
  }

  if (
    payload.new_record &&
    payload.new_record.id &&
    payload.new_record.application_id
  ) {
    return payload.new_record;
  }

  if (
    payload.data &&
    payload.data.record &&
    payload.data.record.id &&
    payload.data.record.application_id
  ) {
    return payload.data.record;
  }

  if (
    payload.data &&
    payload.data.new_record &&
    payload.data.new_record.id &&
    payload.data.new_record.application_id
  ) {
    return payload.data.new_record;
  }

  return null;
}


// ============================================================
// SUPABASE
// ============================================================

function supabaseHeaders(env) {
  return {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };
}


async function supabaseFetch(env, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...supabaseHeaders(env),
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}


// ============================================================
// LOAD ALL BUSINESS DATA
// ============================================================

async function fetchAllBusinessData(env, applicationId) {
  const all = [];

  let offset = 0;

  const pageSize = 1000;

  while (true) {
    const url =
      `${env.SUPABASE_URL}/rest/v1/business_data` +
      `?select=*` +
      `&application_id=eq.${encodeURIComponent(applicationId)}` +
      `&order=created_at.asc` +
      `&limit=${pageSize}` +
      `&offset=${offset}`;

    const rows = await supabaseFetch(env, url);

    if (!Array.isArray(rows)) {
      throw new Error("business_data response was not an array.");
    }

    all.push(...rows);

    if (rows.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  return all;
}


// ============================================================
// GROUP BUSINESS DATA INTO PAGES
// ============================================================

function groupRowsIntoPages(rows) {
  const map = new Map();

  for (const row of rows) {
    const sourceUrl =
      normalizeUrl(row.source_url) ||
      `row:${row.id}`;

    if (!map.has(sourceUrl)) {
      map.set(sourceUrl, {
        source_url: row.source_url || null,
        rows: []
      });
    }

    map.get(sourceUrl).rows.push(row);
  }

  return Array.from(map.values());
}


// ============================================================
// MAIN EXTRACTION
// ============================================================

function extractKnowledge(pages) {
  const records = [];

  const pending = [];

  for (const page of pages) {
    const pageRecords = parsePage(page);

    for (const record of pageRecords.records) {
      records.push({
        ...record,
        source_url: page.source_url
      });
    }

    for (const item of pageRecords.pending) {
      if (pending.length >= MAX_PENDING_ITEMS) {
        break;
      }

      pending.push({
        source_url: page.source_url,
        text: truncate(item.text, MAX_PENDING_CHARS),
        reason: item.reason
      });
    }
  }

  // Merge fields across pages.
  const merged = mergeRecords(records);

  // Add pending only when something genuinely could not
  // be assigned safely.
  if (pending.length) {
    merged.set(
      "pending",
      {
        field: "pending",
        data: pending,
        source_urls: unique(
          pending
            .map(x => x.source_url)
            .filter(Boolean)
        )
      }
    );
  }

  return Array.from(merged.values());
}


// ============================================================
// PAGE PARSER
// ============================================================

function parsePage(page) {
  const records = [];
  const pending = [];

  // ----------------------------------------------------------
  // Each business_data row may contain:
  //
  // data = object
  // data = array
  // data = string
  //
  // We NEVER assume field names have business meaning.
  // ----------------------------------------------------------

  for (const row of page.rows) {
    const value = normalizeData(row.data);

    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }

    // --------------------------------------------------------
    // JSON object / array
    // --------------------------------------------------------

    if (
      typeof value === "object"
    ) {
      const extracted = extractStructuredObject(
        value
      );

      for (const item of extracted.records) {
        records.push(item);
      }

      for (const item of extracted.pending) {
        pending.push(item);
      }

      continue;
    }

    // --------------------------------------------------------
    // Plain text
    // --------------------------------------------------------

    if (typeof value === "string") {
      const text = cleanText(value);

      if (!text) {
        continue;
      }

      const parsed = parseText(
        text
      );

      records.push(...parsed.records);
      pending.push(...parsed.pending);
    }
  }

  return {
    records,
    pending
  };
}


// ============================================================
// STRUCTURED OBJECT PARSER
// ============================================================

function extractStructuredObject(value, prefix = "") {
  const records = [];
  const pending = [];

  if (Array.isArray(value)) {
    const cleaned = value
      .map(normalizeData)
      .filter(x => x !== null && x !== undefined && x !== "");

    if (cleaned.length) {
      if (prefix) {
        records.push({
          field: normalizeField(prefix),
          data: cleaned
        });
      } else {
        pending.push({
          text: JSON.stringify(cleaned),
          reason: "Structured array had no source field name."
        });
      }
    }

    return {
      records,
      pending
    };
  }

  if (
    value &&
    typeof value === "object"
  ) {
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = normalizeField(rawKey);

      if (!key) {
        continue;
      }

      const normalized = normalizeData(rawValue);

      if (
        normalized === null ||
        normalized === undefined ||
        normalized === ""
      ) {
        continue;
      }

      // Preserve actual object relationships.
      //
      // We do NOT rename:
      // services -> ...
      // doctor -> ...
      // etc.
      //
      // The original source key is the field.

      if (
        typeof normalized === "object"
      ) {
        records.push({
          field: key,
          data: normalized
        });
      } else {
        records.push({
          field: key,
          data: normalized
        });
      }
    }
  }

  return {
    records,
    pending
  };
}


// ============================================================
// TEXT PARSER
// ============================================================

function parseText(text) {
  const records = [];
  const pending = [];

  const normalized = normalizeText(text);

  if (!normalized) {
    return {
      records,
      pending
    };
  }

  const blocks = splitIntoBlocks(
    normalized
  );

  const usefulBlocks = removeDuplicateBlocks(
    blocks
  );

  for (const block of usefulBlocks) {
    const parsed = parseBlock(
      block
    );

    records.push(...parsed.records);

    if (parsed.pending) {
      pending.push(parsed.pending);
    }
  }

  return {
    records,
    pending
  };
}


// ============================================================
// BLOCK PARSER
// ============================================================

function parseBlock(block) {
  const records = [];

  const cleaned = cleanText(block);

  if (!cleaned) {
    return {
      records,
      pending: null
    };
  }

  // ----------------------------------------------------------
  // JSON
  // ----------------------------------------------------------

  const jsonValue = tryParseJson(cleaned);

  if (
    jsonValue !== null &&
    typeof jsonValue === "object"
  ) {
    const result =
      extractStructuredObject(jsonValue);

    return {
      records: result.records,
      pending: result.pending.length
        ? result.pending[0]
        : null
    };
  }

  // ----------------------------------------------------------
  // Numbered/bulleted lines are normalized FIRST.
  //
  // This prevents:
  //
  // 01.
  // Root Canal Treatment
  //
  // from becoming:
  //
  // root_canal_treatment -> next line
  // ----------------------------------------------------------

  const lines = cleaned
    .split("\n")
    .map(x => cleanLine(x))
    .filter(Boolean);

  const normalizedLines =
    normalizeListMarkers(lines);

  // ----------------------------------------------------------
  // Explicit label/value structure
  //
  // IMPORTANT:
  // We require multiple explicit pairs.
  //
  // This prevents article titles such as:
  //
  // Emergency Dental Problems:
  // When Should You See...
  //
  // from being treated as:
  //
  // emergency_dental_problems = ...
  // ----------------------------------------------------------

  const explicitPairs =
    extractExplicitPairs(normalizedLines);

  if (explicitPairs.length >= 2) {
    for (const pair of explicitPairs) {
      records.push({
        field: normalizeField(pair.label),
        data: pair.value
      });
    }

    return {
      records,
      pending: null
    };
  }

  // ----------------------------------------------------------
  // Single universal data types
  // ----------------------------------------------------------

  if (normalizedLines.length === 1) {
    const line = normalizedLines[0];

    const email = extractEmail(line);

    if (email) {
      return {
        records: [
          {
            field: "email",
            data: email
          }
        ],
        pending: null
      };
    }

    const phone = extractPhone(line);

    if (phone) {
      return {
        records: [
          {
            field: "phone",
            data: phone
          }
        ],
        pending: null
      };
    }

    // Standalone URLs are kept generically.
    const url = extractUrl(line);

    if (url) {
      return {
        records: [
          {
            field: "url",
            data: url
          }
        ],
        pending: null
      };
    }

    // A standalone short line is NOT a field.
    return {
      records,
      pending: null
    };
  }

  // ----------------------------------------------------------
  // Multi-line structural block
  // ----------------------------------------------------------

  const first = normalizedLines[0];

  if (isHeadingLike(first)) {
    const body = normalizedLines.slice(1);

    // --------------------------------------------------------
    // Detect a list
    // --------------------------------------------------------

    if (
      body.length >= 2 &&
      looksLikeList(body)
    ) {
      const items = body
        .map(stripListMarker)
        .map(cleanLine)
        .filter(Boolean);

      if (items.length >= 2) {
        records.push({
          field: normalizeField(first),
          data: unique(items)
        });

        return {
          records,
          pending: null
        };
      }
    }

    // --------------------------------------------------------
    // Detect content under heading
    // --------------------------------------------------------

    const bodyText = body
      .join("\n\n")
      .trim();

    if (
      bodyText &&
      containsMeaningfulProse(bodyText)
    ) {
      records.push({
        field: normalizeField(first),
        data: bodyText
      });

      return {
        records,
        pending: null
      };
    }
  }

  // ----------------------------------------------------------
  // Table-like data
  // ----------------------------------------------------------

  const table = parseGenericTable(
    normalizedLines
  );

  if (table) {
    records.push({
      field: table.field,
      data: table.data
    });

    return {
      records,
      pending: null
    };
  }

  // ----------------------------------------------------------
  // Generic typed values inside a block
  // ----------------------------------------------------------

  const emails = unique(
    normalizedLines
      .flatMap(extractAllEmails)
  );

  if (emails.length) {
    records.push({
      field: "email",
      data:
        emails.length === 1
          ? emails[0]
          : emails
    });
  }

  const phones = unique(
    normalizedLines
      .flatMap(extractAllPhones)
  );

  if (phones.length) {
    records.push({
      field: "phone",
      data:
        phones.length === 1
          ? phones[0]
          : phones
    });
  }

  const urls = unique(
    normalizedLines
      .flatMap(extractAllUrls)
  );

  if (urls.length) {
    records.push({
      field: "url",
      data:
        urls.length === 1
          ? urls[0]
          : urls
    });
  }

  if (records.length) {
    return {
      records,
      pending: null
    };
  }

  // ----------------------------------------------------------
  // IMPORTANT:
  //
  // We don't understand this block reliably.
  //
  // DO NOT INVENT A FIELD.
  // ----------------------------------------------------------

  return {
    records,
    pending: {
      text: cleaned,
      reason:
        "Meaningful content detected but no reliable structural field relationship was found."
    }
  };
}


// ============================================================
// EXPLICIT LABEL/VALUE PARSER
// ============================================================

function extractExplicitPairs(lines) {
  const pairs = [];

  for (const line of lines) {
    // Only colon-based structures.
    //
    // We deliberately do NOT use generic "-"
    // because titles and prose contain hyphens constantly.

    const match = line.match(
      /^([^:]{1,100}):\s*(.{1,1000})$/
    );

    if (!match) {
      continue;
    }

    const label = cleanLine(match[1]);
    const value = cleanLine(match[2]);

    if (!label || !value) {
      continue;
    }

    if (!isPlausibleLabel(label)) {
      continue;
    }

    pairs.push({
      label,
      value
    });
  }

  return pairs;
}


function isPlausibleLabel(value) {
  if (!value) {
    return false;
  }

  if (value.length > 100) {
    return false;
  }

  if (extractEmail(value)) {
    return false;
  }

  if (extractUrl(value)) {
    return false;
  }

  if (extractPhone(value)) {
    return false;
  }

  // A label normally isn't a complete sentence.
  if (/[.!?]$/.test(value)) {
    return false;
  }

  const words = value
    .split(/\s+/)
    .filter(Boolean);

  return words.length <= 12;
}


// ============================================================
// LIST DETECTION
// ============================================================

function normalizeListMarkers(lines) {
  const result = [];

  let pendingMarker = null;

  for (const line of lines) {
    const markerMatch = line.match(
      /^\s*(?:[-*•●▪◦]|\d{1,4}[.)])\s*$/
    );

    if (markerMatch) {
      pendingMarker = line.trim();
      continue;
    }

    if (pendingMarker) {
      result.push(
        `${pendingMarker} ${line}`.trim()
      );

      pendingMarker = null;
    } else {
      result.push(line);
    }
  }

  if (pendingMarker) {
    result.push(pendingMarker);
  }

  return result;
}


function looksLikeList(lines) {
  if (lines.length < 2) {
    return false;
  }

  let markerCount = 0;

  for (const line of lines) {
    if (
      /^\s*(?:[-*•●▪◦]|\d{1,4}[.)])\s+/.test(line)
    ) {
      markerCount++;
    }
  }

  // Explicit list markers are strong evidence.
  if (markerCount >= 2) {
    return true;
  }

  // Otherwise detect similarly shaped short items.
  const short = lines.filter(
    line =>
      line.length >= 2 &&
      line.length <= 180
  );

  if (short.length < 2) {
    return false;
  }

  const ratio =
    short.length / lines.length;

  return ratio >= 0.8;
}


function stripListMarker(value) {
  return value
    .replace(
      /^\s*(?:[-*•●▪◦]|\d{1,4}[.)])\s+/,
      ""
    )
    .trim();
}


// ============================================================
// TABLE DETECTION
// ============================================================

function parseGenericTable(lines) {
  if (lines.length < 3) {
    return null;
  }

  // Detect repeated whitespace-separated columns.
  const rows = [];

  for (const line of lines) {
    const columns = line
      .split(/\s{2,}|\t+/)
      .map(cleanLine)
      .filter(Boolean);

    if (columns.length >= 2) {
      rows.push(columns);
    }
  }

  if (rows.length < 3) {
    return null;
  }

  const width = rows[0].length;

  if (
    !rows.every(row => row.length === width)
  ) {
    return null;
  }

  // Generic table. No semantic assumptions.
  const headers = rows[0];

  const body = rows.slice(1).map(row => {
    const object = {};

    for (let i = 0; i < headers.length; i++) {
      object[
        normalizeField(headers[i]) || `column_${i + 1}`
      ] = row[i];
    }

    return object;
  });

  return {
    field: "table",
    data: body
  };
}


// ============================================================
// HEADING DETECTION
// ============================================================

function isHeadingLike(value) {
  if (!value) {
    return false;
  }

  if (value.length < 2 || value.length > 150) {
    return false;
  }

  if (extractEmail(value)) {
    return false;
  }

  if (extractUrl(value)) {
    return false;
  }

  if (extractPhone(value)) {
    return false;
  }

  if (/[.!?]$/.test(value)) {
    return false;
  }

  const words = value
    .split(/\s+/)
    .filter(Boolean);

  if (words.length > 18) {
    return false;
  }

  // Navigation-like single short words are not useful headings.
  if (
    words.length === 1 &&
    value.length < 8
  ) {
    return false;
  }

  return true;
}


// ============================================================
// PROSE DETECTION
// ============================================================

function containsMeaningfulProse(text) {
  if (!text) {
    return false;
  }

  if (text.length < 40) {
    return false;
  }

  const words = text
    .split(/\s+/)
    .filter(Boolean);

  if (words.length < 7) {
    return false;
  }

  return true;
}


// ============================================================
// BLOCK SPLITTING
// ============================================================

function splitIntoBlocks(text) {
  const blocks = text
    .split(/\n\s*\n+/)
    .map(cleanText)
    .filter(Boolean);

  if (blocks.length <= MAX_BLOCKS_PER_PAGE) {
    return blocks;
  }

  return blocks.slice(
    0,
    MAX_BLOCKS_PER_PAGE
  );
}


// ============================================================
// DUPLICATE BLOCK REMOVAL
// ============================================================

function removeDuplicateBlocks(blocks) {
  const seen = new Set();
  const result = [];

  for (const block of blocks) {
    const key = normalizeForComparison(block);

    if (!key) {
      continue;
    }

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(block);
  }

  return result;
}


// ============================================================
// DATA NORMALIZATION
// ============================================================

function normalizeData(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const cleaned = cleanText(value);

    const parsed = tryParseJson(cleaned);

    if (
      parsed !== null &&
      typeof parsed === "object"
    ) {
      return parsed;
    }

    return cleaned;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map(normalizeData)
      .filter(x => x !== null && x !== undefined && x !== "");
  }

  if (typeof value === "object") {
    const result = {};

    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeData(child);

      if (
        normalized !== null &&
        normalized !== undefined &&
        normalized !== ""
      ) {
        result[key] = normalized;
      }
    }

    return result;
  }

  return String(value);
}


// ============================================================
// TEXT CLEANING
// ============================================================

function normalizeText(value) {
  return decodeHtmlEntities(
    String(value)
  )
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}


function cleanText(value) {
  return normalizeText(value)
    .replace(/\u00a0/g, " ")
    .trim();
}


function cleanLine(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .trim();
}


function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}


function normalizeForComparison(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\s+/g, " ");
}


// ============================================================
// FIELD NORMALIZATION
// ============================================================

function normalizeField(value) {
  if (value === null || value === undefined) {
    return "";
  }

  let result = String(value)
    .trim()
    .toLowerCase();

  result = decodeHtmlEntities(result);

  result = result
    .replace(/['’"`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  if (!result) {
    return "";
  }

  return result.slice(0, 200);
}


// ============================================================
// EMAIL
// ============================================================

function extractEmail(value) {
  const match = String(value).match(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
  );

  return match
    ? match[0]
    : null;
}


function extractAllEmails(value) {
  return String(value).match(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
  ) || [];
}


// ============================================================
// PHONE
// ============================================================

function extractPhone(value) {
  const matches = extractAllPhones(value);

  if (!matches.length) {
    return null;
  }

  return matches[0];
}


function extractAllPhones(value) {
  const matches =
    String(value).match(
      /(?:\+?\d[\d\s().-]{7,}\d)/g
    ) || [];

  return matches
    .map(x => x.trim())
    .filter(x => {
      const digits =
        x.replace(/\D/g, "");

      return (
        digits.length >= 8 &&
        digits.length <= 15
      );
    });
}


// ============================================================
// URL
// ============================================================

function extractUrl(value) {
  const match = String(value).match(
    /\bhttps?:\/\/[^\s<>"']+/i
  );

  return match
    ? match[0].replace(/[),.;]+$/, "")
    : null;
}


function extractAllUrls(value) {
  return (
    String(value).match(
      /\bhttps?:\/\/[^\s<>"']+/gi
    ) || []
  ).map(x =>
    x.replace(/[),.;]+$/, "")
  );
}


function normalizeUrl(value) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).toString();
  } catch {
    return String(value).trim();
  }
}


// ============================================================
// JSON
// ============================================================

function tryParseJson(value) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return null;
  }

  const text = value.trim();

  if (
    !(
      text.startsWith("{") ||
      text.startsWith("[") ||
      text.startsWith('"')
    )
  ) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}


// ============================================================
// MERGING
// ============================================================

function mergeRecords(records) {
  const map = new Map();

  for (const record of records) {
    if (
      !record ||
      !record.field
    ) {
      continue;
    }

    const field =
      normalizeField(record.field);

    if (!field) {
      continue;
    }

    const existing = map.get(field);

    const sourceUrls =
      unique(
        [
          ...(existing?.source_urls || []),
          ...(record.source_url
            ? [record.source_url]
            : [])
        ].filter(Boolean)
      );

    if (!existing) {
      map.set(
        field,
        {
          field,
          data: record.data,
          source_urls: sourceUrls
        }
      );

      continue;
    }

    existing.data =
      mergeValues(
        existing.data,
        record.data
      );

    existing.source_urls =
      sourceUrls;
  }

  return map;
}


function mergeValues(a, b) {
  if (
    JSON.stringify(a) ===
    JSON.stringify(b)
  ) {
    return a;
  }

  if (
    Array.isArray(a) &&
    Array.isArray(b)
  ) {
    return uniqueDeep([
      ...a,
      ...b
    ]);
  }

  if (
    a &&
    typeof a === "object" &&
    !Array.isArray(a) &&
    b &&
    typeof b === "object" &&
    !Array.isArray(b)
  ) {
    return {
      ...a,
      ...b
    };
  }

  if (Array.isArray(a)) {
    return uniqueDeep([
      ...a,
      b
    ]);
  }

  if (Array.isArray(b)) {
    return uniqueDeep([
      a,
      ...b
    ]);
  }

  return uniqueDeep([
    a,
    b
  ]);
}


function unique(values) {
  return Array.from(
    new Set(
      values.filter(
        x =>
          x !== null &&
          x !== undefined &&
          x !== ""
      )
    )
  );
}


function uniqueDeep(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const key = JSON.stringify(value);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
}


// ============================================================
// DATABASE WRITE
// ============================================================

async function deleteApplicationKnowledge(
  env,
  applicationId
) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}`;

  await supabaseFetch(
    env,
    url,
    {
      method: "DELETE"
    }
  );
}


async function insertKnowledge(
  env,
  applicationId,
  knowledge
) {
  const now =
    new Date().toISOString();

  const rows = knowledge.map(item => ({
    application_id: applicationId,
    field: item.field,
    data: item.data,
    created_at: now,
    updated_at: now,
    source_urls: unique(
      item.source_urls || []
    )
  }));

  if (!rows.length) {
    return;
  }

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge`;

  await supabaseFetch(
    env,
    url,
    {
      method: "POST",
      headers: {
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(rows)
    }
  );
}


// ============================================================
// BUSINESS DATA STATUS
// ============================================================

async function markRowsCompleted(
  env,
  rows
) {
  for (const row of rows) {
    if (!row.id) {
      continue;
    }

    const url =
      `${env.SUPABASE_URL}/rest/v1/business_data` +
      `?id=eq.${encodeURIComponent(row.id)}`;

    await supabaseFetch(
      env,
      url,
      {
        method: "PATCH",
        body: JSON.stringify({
          ai_status: "completed",
          ai_error: null,
          updated_at:
            new Date().toISOString()
        })
      }
    );
  }
}


async function markRowError(
  env,
  id,
  message
) {
  if (!id) {
    return;
  }

  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}`;

  try {
    await supabaseFetch(
      env,
      url,
      {
        method: "PATCH",
        body: JSON.stringify({
          ai_status: "error",
          ai_error: truncate(
            message,
            2000
          ),
          updated_at:
            new Date().toISOString()
        })
      }
    );
  } catch (_) {
    // Ignore secondary failure.
  }
}


// ============================================================
// UTILITY
// ============================================================

function truncate(value, max) {
  const text = String(value || "");

  if (text.length <= max) {
    return text;
  }

  return text.slice(0, max) + "...";
}


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


/**
 * Request bodies cannot normally be read twice.
 *
 * This helper exists only as a best-effort error path.
 */
async function safeCloneRequestBody(request) {
  try {
    const clone = request.clone();

    return await clone.json();
  } catch {
    return null;
  }
          }
