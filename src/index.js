/**
 * Reportli AI
 * ai-business-knowledge-worker
 *
 * GENERIC STRUCTURAL KNOWLEDGE EXTRACTOR
 *
 * IMPORTANT:
 * ------------------------------------------------------------
 * This worker does NOT understand business categories.
 *
 * It does NOT contain:
 *   dental
 *   restaurant
 *   hotel
 *   doctor
 *   salon
 *   services
 *   products
 *   menu
 *   clinic
 *   etc.
 *
 * It only understands:
 *
 *   - JSON/object structure
 *   - explicit key/value relationships
 *   - explicit "label: value" relationships
 *   - repeated website boilerplate
 *   - generic text structure
 *   - generic formats such as email / URL / phone / date
 *   - headings and their following content
 *   - lists
 *
 * The worker reads business_data.
 * It NEVER scrapes the website.
 * It NEVER calls an AI API.
 * ------------------------------------------------------------
 */


// ============================================================
// CONFIG
// ============================================================

const MAX_ROWS = 500;
const MAX_LINES_PER_PAGE = 5000;
const MAX_TEXT_LENGTH = 100000;
const MAX_SECTION_LENGTH = 50000;

const MIN_REPEATED_PAGES = 2;

const MAX_PENDING = 100;


// ============================================================
// MAIN
// ============================================================

export default {
  async fetch(request, env) {

    if (request.method !== "POST") {
      return json({
        success: false,
        error: "POST required"
      }, 405);
    }

    let payload;

    try {
      payload = await request.json();
    } catch {
      return json({
        success: false,
        error: "Invalid JSON"
      }, 400);
    }

    try {

      // ------------------------------------------------------
      // Find webhook record
      // ------------------------------------------------------

      const record = extractRecord(payload);

      if (!record) {
        return json({
          success: false,
          error: "business_data record not found"
        }, 400);
      }

      const applicationId = record.application_id;

      if (!applicationId) {
        return json({
          success: false,
          error: "application_id missing"
        }, 400);
      }


      // ------------------------------------------------------
      // IMPORTANT:
      //
      // Do NOT process only the webhook row.
      //
      // Fetch all business_data rows for this application.
      //
      // This allows us to detect repeated navigation/footer/
      // header content across pages.
      // ------------------------------------------------------

      const rows = await getBusinessData(
        env,
        applicationId
      );


      if (!rows.length) {

        await updateBusinessDataStatus(
          env,
          record.id,
          "error",
          "No business_data rows found"
        );

        return json({
          success: false,
          error: "No business_data rows found"
        }, 404);
      }


      // ------------------------------------------------------
      // Build page representations
      // ------------------------------------------------------

      const pages = [];

      for (const row of rows) {

        const page = createPageRepresentation(row);

        if (!page) {
          continue;
        }

        pages.push(page);
      }


      // ------------------------------------------------------
      // Find repeated content across pages.
      //
      // Example:
      //
      // About
      // Services
      // Portfolio
      // Testimonials
      // Blog
      //
      // repeated on every page.
      //
      // We remove these blocks structurally instead of
      // hardcoding their names.
      // ------------------------------------------------------

      const repeated = findRepeatedLines(pages);


      // ------------------------------------------------------
      // Parse every page
      // ------------------------------------------------------

      const knowledge = [];
      const pending = [];

      for (const page of pages) {

        const cleanedLines =
          removeRepeatedLines(
            page.lines,
            repeated
          );

        const parsed =
          parsePage(
            cleanedLines,
            page
          );


        for (const item of parsed.knowledge) {
          knowledge.push(item);
        }


        for (const item of parsed.pending) {

          if (pending.length < MAX_PENDING) {
            pending.push(item);
          }

        }
      }


      // ------------------------------------------------------
      // Deduplicate knowledge
      // ------------------------------------------------------

      const finalKnowledge =
        mergeKnowledge(
          knowledge
        );


      // ------------------------------------------------------
      // Save knowledge
      // ------------------------------------------------------

      let saved = 0;

      for (const item of finalKnowledge) {

        const ok =
          await saveKnowledge(
            env,
            applicationId,
            item
          );

        if (ok) {
          saved++;
        }
      }


      // ------------------------------------------------------
      // Save pending content
      // ------------------------------------------------------

      for (const item of pending) {

        await saveKnowledge(
          env,
          applicationId,
          {
            field: "pending",
            data: item.data,
            sourceUrls: item.sourceUrls
          }
        );
      }


      // ------------------------------------------------------
      // Mark current webhook row completed
      // ------------------------------------------------------

      await updateBusinessDataStatus(
        env,
        record.id,
        "completed",
        null
      );


      return json({
        success: true,
        application_id: applicationId,
        business_data_rows: rows.length,
        pages_processed: pages.length,
        repeated_lines_removed: repeated.size,
        knowledge_records: finalKnowledge.length,
        saved,
        pending: pending.length
      });

    } catch (error) {

      console.error(
        "Knowledge worker error:",
        error
      );

      try {

        const record =
          extractRecord(payload);

        if (record?.id) {

          await updateBusinessDataStatus(
            env,
            record.id,
            "error",
            error?.message || String(error)
          );
        }

      } catch (statusError) {

        console.error(
          "Could not update error status:",
          statusError
        );
      }


      return json({
        success: false,
        error:
          error?.message ||
          String(error)
      }, 500);
    }
  }
};


// ============================================================
// WEBHOOK RECORD
// ============================================================

function extractRecord(payload) {

  if (!payload || typeof payload !== "object") {
    return null;
  }


  // Direct Supabase Database Webhook payload

  if (
    payload.id &&
    payload.application_id &&
    Object.prototype.hasOwnProperty.call(
      payload,
      "data"
    )
  ) {
    return payload;
  }


  // Wrapped payload

  if (
    payload.record &&
    typeof payload.record === "object"
  ) {
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
// SUPABASE
// ============================================================

function supabaseHeaders(env) {

  return {
    apikey:
      env.SUPABASE_SERVICE_ROLE_KEY,

    Authorization:
      `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

    "Content-Type":
      "application/json"
  };
}


function tableUrl(env, table) {

  return `${env.SUPABASE_URL}/rest/v1/${table}`;
}


// ============================================================
// GET ALL BUSINESS DATA FOR APPLICATION
// ============================================================

async function getBusinessData(
  env,
  applicationId
) {

  const url =
    `${tableUrl(
      env,
      "business_data"
    )}` +
    `?application_id=eq.${encodeURIComponent(
      applicationId
    )}` +
    `&select=id,application_id,field,data,source_url,created_at,updated_at` +
    `&order=created_at.asc` +
    `&limit=${MAX_ROWS}`;


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

    throw new Error(
      `Failed to read business_data: ${await response.text()}`
    );
  }


  return await response.json();
}


// ============================================================
// PAGE REPRESENTATION
// ============================================================

function createPageRepresentation(row) {

  if (!row) {
    return null;
  }


  const sourceUrl =
    cleanString(row.source_url);


  const rawData =
    row.data;


  let text;


  // ----------------------------------------------------------
  // If scraper stored an object, preserve it separately.
  // ----------------------------------------------------------

  if (
    rawData &&
    typeof rawData === "object"
  ) {

    return {
      id: row.id,
      sourceUrl,
      originalData: rawData,
      lines: objectToLines(
        rawData
      )
    };
  }


  // ----------------------------------------------------------
  // Otherwise process raw text.
  // ----------------------------------------------------------

  text =
    cleanString(
      rawData
    );


  if (!text) {
    return null;
  }


  if (text.length > MAX_TEXT_LENGTH) {

    text =
      text.slice(
        0,
        MAX_TEXT_LENGTH
      );
  }


  return {
    id: row.id,
    sourceUrl,
    originalData: null,
    lines:
      textToLines(text)
  };
}


// ============================================================
// OBJECT → LINES
// ============================================================

function objectToLines(object) {

  const lines = [];

  walkObject(
    object,
    [],
    lines
  );

  return lines;
}


function walkObject(
  value,
  path,
  lines
) {

  if (
    value === null ||
    value === undefined
  ) {
    return;
  }


  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {

    lines.push({
      text: normalizeText(
        String(value)
      ),

      path: [...path],

      explicit:
        path.length > 0
    });

    return;
  }


  if (Array.isArray(value)) {

    for (const item of value) {

      walkObject(
        item,
        path,
        lines
      );
    }

    return;
  }


  if (typeof value === "object") {

    for (const [
      key,
      child
    ] of Object.entries(value)) {

      walkObject(
        child,
        [
          ...path,
          key
        ],
        lines
      );
    }
  }
}


// ============================================================
// TEXT → LINES
// ============================================================

function textToLines(text) {

  return String(text)
    .split(/\r?\n/)
    .map(line => {

      return {
        text:
          normalizeText(line),

        path: [],

        explicit: false
      };

    })
    .filter(item => item.text);
}


// ============================================================
// REPEATED LINE DETECTION
// ============================================================

function findRepeatedLines(pages) {

  const counts =
    new Map();


  for (const page of pages) {

    // Only count a line once per page.
    const seen =
      new Set();


    for (const item of page.lines) {

      const key =
        fingerprint(
          item.text
        );


      if (!key) {
        continue;
      }


      if (seen.has(key)) {
        continue;
      }


      seen.add(key);


      if (!counts.has(key)) {

        counts.set(
          key,
          {
            count: 0,
            text: item.text
          }
        );
      }


      counts.get(key).count++;
    }
  }


  const repeated =
    new Set();


  for (
    const [
      key,
      value
    ] of counts
  ) {

    if (
      value.count >=
      MIN_REPEATED_PAGES
    ) {

      repeated.add(key);
    }
  }


  return repeated;
}


// ============================================================
// REMOVE REPEATED CONTENT
// ============================================================

function removeRepeatedLines(
  lines,
  repeated
) {

  return lines.filter(
    item => {

      const key =
        fingerprint(
          item.text
        );


      if (
        key &&
        repeated.has(key) &&
        !item.explicit
      ) {

        return false;
      }


      return true;
    }
  );
}


// ============================================================
// PAGE PARSER
// ============================================================

function parsePage(
  lines,
  page
) {

  const knowledge = [];
  const pending = [];


  // ----------------------------------------------------------
  // First: explicit object relationships.
  //
  // These are the safest possible relationships because the
  // source itself gave us:
  //
  // key -> value
  // ----------------------------------------------------------

  for (const item of lines) {

    if (
      item.explicit &&
      item.path.length > 0
    ) {

      const field =
        normalizeFieldName(
          item.path[
            item.path.length - 1
          ]
        );


      if (
        field &&
        item.text
      ) {

        knowledge.push({

          field,

          data:
            item.text,

          sourceUrls:
            page.sourceUrl
              ? [page.sourceUrl]
              : []
        });
      }
    }
  }


  // ----------------------------------------------------------
  // Then parse raw text structurally.
  // ----------------------------------------------------------

  const textLines =
    lines
      .filter(
        item =>
          !item.explicit
      )
      .map(
        item =>
          item.text
      )
      .filter(Boolean);


  if (!textLines.length) {

    return {
      knowledge,
      pending
    };
  }


  // ----------------------------------------------------------
  // Remove obvious duplicates inside this page.
  // ----------------------------------------------------------

  const uniqueLines =
    uniqueTextLines(
      textLines
    );


  // ----------------------------------------------------------
  // Explicit "label: value" structures.
  //
  // This is allowed because the source itself provides the
  // relationship.
  // ----------------------------------------------------------

  const consumed =
    new Set();


  for (
    let i = 0;
    i < uniqueLines.length;
    i++
  ) {

    const parsed =
      parseExplicitLabelValue(
        uniqueLines[i]
      );


    if (!parsed) {
      continue;
    }


    knowledge.push({

      field:
        parsed.field,

      data:
        parsed.data,

      sourceUrls:
        page.sourceUrl
          ? [page.sourceUrl]
          : []
    });


    consumed.add(i);
  }


  // ----------------------------------------------------------
  // Detect generic values.
  //
  // ONLY when the entire line itself clearly has that format.
  //
  // This prevents:
  //
  // "Root Canal Treatment (RCT)"
  //
  // from being treated as a field.
  // ----------------------------------------------------------

  for (
    let i = 0;
    i < uniqueLines.length;
    i++
  ) {

    if (consumed.has(i)) {
      continue;
    }


    const value =
      detectStandaloneValue(
        uniqueLines[i]
      );


    if (!value) {
      continue;
    }


    knowledge.push({

      field:
        value.field,

      data:
        value.data,

      sourceUrls:
        page.sourceUrl
          ? [page.sourceUrl]
          : []
    });


    consumed.add(i);
  }


  // ----------------------------------------------------------
  // Find actual structural sections.
  // ----------------------------------------------------------

  const sections =
    findSections(
      uniqueLines,
      consumed
    );


  for (const section of sections) {

    knowledge.push({

      field:
        normalizeFieldName(
          section.heading
        ),

      data:
        section.data,

      sourceUrls:
        page.sourceUrl
          ? [page.sourceUrl]
          : []
    });


    for (
      const index of section.indices
    ) {

      consumed.add(index);
    }
  }


  // ----------------------------------------------------------
  // Anything still meaningful but not structurally
  // classifiable goes to pending.
  //
  // IMPORTANT:
  // We do NOT invent a semantic field.
  // ----------------------------------------------------------

  const remaining = [];


  for (
    let i = 0;
    i < uniqueLines.length;
    i++
  ) {

    if (consumed.has(i)) {
      continue;
    }


    const text =
      uniqueLines[i];


    if (
      !isMeaningful(
        text
      )
    ) {
      continue;
    }


    remaining.push(text);
  }


  if (remaining.length) {

    pending.push({

      data: {

        source_url:
          page.sourceUrl || null,

        text:
          remaining.join("\n")
      },

      sourceUrls:
        page.sourceUrl
          ? [page.sourceUrl]
          : []
    });
  }


  return {
    knowledge,
    pending
  };
}


// ============================================================
// EXPLICIT LABEL/VALUE
// ============================================================

function parseExplicitLabelValue(
  text
) {

  // Only a single clear delimiter.
  //
  // Example:
  //
  // Address: Something
  //
  // We do NOT treat:
  //
  // "A: B: C"
  //
  // as a field.

  const match =
    text.match(
      /^([^:\n]{2,100}):\s*(.{1,10000})$/
    );


  if (!match) {
    return null;
  }


  const label =
    normalizeText(
      match[1]
    );


  const value =
    normalizeText(
      match[2]
    );


  if (!label || !value) {
    return null;
  }


  if (
    label.split(/\s+/).length >
    12
  ) {
    return null;
  }


  if (
    isNavigationLike(
      label
    )
  ) {
    return null;
  }


  return {

    field:
      normalizeFieldName(
        label
      ),

    data:
      value
  };
}


// ============================================================
// STANDALONE FORMAT DETECTION
// ============================================================

function detectStandaloneValue(
  text
) {

  const value =
    normalizeText(
      text
    );


  // Entire line is an email.
  if (
    looksLikeEmail(
      value
    )
  ) {

    return {
      field: "email",
      data: value
    };
  }


  // Entire line is a URL.
  if (
    looksLikeUrl(
      value
    )
  ) {

    return {
      field: "url",
      data: value
    };
  }


  // Entire line is a phone number.
  if (
    looksLikePhone(
      value
    )
  ) {

    return {
      field: "phone",
      data: value
    };
  }


  // Entire line is a date.
  if (
    looksLikeDate(
      value
    )
  ) {

    return {
      field: "date",
      data: value
    };
  }


  return null;
}


// ============================================================
// SECTION DETECTION
// ============================================================

function findSections(
  lines,
  consumed
) {

  const sections = [];


  for (
    let i = 0;
    i < lines.length;
    i++
  ) {

    if (consumed.has(i)) {
      continue;
    }


    const heading =
      lines[i];


    if (
      !looksLikeHeading(
        heading
      )
    ) {
      continue;
    }


    const nextIndex =
      nextMeaningfulIndex(
        lines,
        i + 1,
        consumed
      );


    if (
      nextIndex === -1
    ) {
      continue;
    }


    const next =
      lines[nextIndex];


    // --------------------------------------------------------
    // A heading followed by several short lines can be a list.
    //
    // Crucially:
    //
    // We require MULTIPLE list-like items.
    //
    // So:
    //
    // Root Canal
    // Tooth Extraction
    // Braces
    //
    // is treated as a list.
    //
    // But:
    //
    // Root Canal
    // 02.
    //
    // is NOT treated as a relationship.
    // --------------------------------------------------------

    const list =
      collectList(
        lines,
        nextIndex,
        consumed
      );


    if (
      list.items.length >= 2
    ) {

      sections.push({

        heading,

        data:
          list.items,

        indices:
          [
            i,
            ...list.indices
          ]
      });


      continue;
    }


    // --------------------------------------------------------
    // Heading followed by substantial prose.
    //
    // We require the following text to be long enough to look
    // like content rather than another navigation item.
    // --------------------------------------------------------

    if (
      isSubstantialText(
        next
      )
    ) {

      const content = [];


      let j =
        nextIndex;


      while (
        j < lines.length
      ) {

        if (
          consumed.has(j)
        ) {
          j++;
          continue;
        }


        const current =
          lines[j];


        if (
          j !== nextIndex &&
          looksLikeHeading(
            current
          )
        ) {
          break;
        }


        if (
          isMeaningful(
            current
          )
        ) {

          content.push(
            current
          );
        }


        j++;


        if (
          content.join("\n")
            .length >=
          MAX_SECTION_LENGTH
        ) {
          break;
        }
      }


      if (content.length) {

        sections.push({

          heading,

          data:
            content.join("\n\n"),

          indices:
            [
              i,
              ...range(
                nextIndex,
                j
              )
            ]
        });
      }
    }
  }


  return sections;
}


// ============================================================
// LIST COLLECTION
// ============================================================

function collectList(
  lines,
  start,
  consumed
) {

  const items = [];
  const indices = [];


  let i = start;


  while (
    i < lines.length
  ) {

    if (
      consumed.has(i)
    ) {
      i++;
      continue;
    }


    const text =
      lines[i];


    if (
      !isListItemLike(
        text
      )
    ) {
      break;
    }


    // Do not accept very long prose as a list item.
    if (
      text.length > 180
    ) {
      break;
    }


    items.push(
      text
    );


    indices.push(
      i
    );


    i++;


    if (
      items.length >= 100
    ) {
      break;
    }
  }


  return {
    items,
    indices
  };
}


// ============================================================
// LIST ITEM DETECTION
// ============================================================

function isListItemLike(
  text
) {

  const value =
    normalizeText(
      text
    );


  if (!value) {
    return false;
  }


  if (
    /^[-*•]\s+/.test(
      value
    )
  ) {
    return true;
  }


  if (
    /^\d+[.)]\s+/.test(
      value
    )
  ) {
    return true;
  }


  // Short standalone phrases can form a list.
  //
  // But don't classify a sentence as a list item.

  if (
    value.length <= 100 &&
    !/[.!?]$/.test(
      value
    )
  ) {

    const words =
      value.split(
        /\s+/
      );


    return (
      words.length <= 10
    );
  }


  return false;
}


// ============================================================
// HEADING DETECTION
// ============================================================

function looksLikeHeading(
  text
) {

  const value =
    normalizeText(
      text
    );


  if (!value) {
    return false;
  }


  if (
    value.length < 2 ||
    value.length > 160
  ) {
    return false;
  }


  // A sentence is normally content.
  if (
    /[.!?]$/.test(
      value
    )
  ) {
    return false;
  }


  const words =
    value.split(
      /\s+/
    );


  if (
    words.length > 15
  ) {
    return false;
  }


  // Pure number is not a heading.
  if (
    /^\d+[.)]?$/.test(
      value
    )
  ) {
    return false;
  }


  return true;
}


// ============================================================
// SUBSTANTIAL TEXT
// ============================================================

function isSubstantialText(
  text
) {

  if (!text) {
    return false;
  }


  if (
    text.length >= 80
  ) {
    return true;
  }


  const words =
    text.split(
      /\s+/
    );


  return (
    words.length >= 14
  );
}


// ============================================================
// NEXT MEANINGFUL LINE
// ============================================================

function nextMeaningfulIndex(
  lines,
  start,
  consumed
) {

  for (
    let i = start;
    i < lines.length;
    i++
  ) {

    if (
      consumed.has(i)
    ) {
      continue;
    }


    if (
      isMeaningful(
        lines[i]
      )
    ) {
      return i;
    }
  }


  return -1;
}


// ============================================================
// REPEATED / NAVIGATION-LIKE CONTENT
// ============================================================

function isNavigationLike(
  text
) {

  const words =
    normalizeText(
      text
    ).split(
      /\s+/
    );


  // Very short labels can be legitimate fields,
  // so this function only rejects obviously structural
  // punctuation patterns.
  //
  // No business vocabulary is used here.

  if (
    words.length > 8
  ) {
    return false;
  }


  return false;
}


// ============================================================
// MEANINGFUL TEXT
// ============================================================

function isMeaningful(
  text
) {

  const value =
    normalizeText(
      text
    );


  if (!value) {
    return false;
  }


  if (
    value.length < 2
  ) {
    return false;
  }


  // Pure punctuation.
  if (
    /^[^A-Za-z0-9]+$/.test(
      value
    )
  ) {
    return false;
  }


  return true;
}


// ============================================================
// UNIQUE LINES
// ============================================================

function uniqueTextLines(
  lines
) {

  const output = [];
  const seen = new Set();


  for (const line of lines) {

    const value =
      normalizeText(
        line
      );


    if (!value) {
      continue;
    }


    const key =
      fingerprint(
        value
      );


    if (
      seen.has(key)
    ) {
      continue;
    }


    seen.add(key);


    output.push(
      value
    );
  }


  return output;
}


// ============================================================
// MERGE KNOWLEDGE
// ============================================================

function mergeKnowledge(
  items
) {

  const map =
    new Map();


  for (const item of items) {

    if (!item.field) {
      continue;
    }


    const existing =
      map.get(
        item.field
      );


    if (!existing) {

      map.set(
        item.field,
        {
          field:
            item.field,

          data:
            item.data,

          sourceUrls:
            uniqueStrings(
              item.sourceUrls || []
            )
        }
      );


      continue;
    }


    existing.data =
      mergeValues(
        existing.data,
        item.data
      );


    existing.sourceUrls =
      uniqueStrings([
        ...existing.sourceUrls,
        ...(item.sourceUrls || [])
      ]);
  }


  return [
    ...map.values()
  ];
}


// ============================================================
// MERGE VALUES
// ============================================================

function mergeValues(
  oldValue,
  newValue
) {

  if (
    Array.isArray(oldValue) &&
    Array.isArray(newValue)
  ) {

    return uniqueObjectsAndStrings([
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


  // Don't create nonsense arrays from unrelated scalar
  // content. Newer structurally identified value wins.

  return newValue;
}


// ============================================================
// SAVE KNOWLEDGE
// ============================================================

async function saveKnowledge(
  env,
  applicationId,
  item
) {

  const field =
    normalizeFieldName(
      item.field
    );


  if (!field) {
    return false;
  }


  const sourceUrls =
    uniqueStrings(
      item.sourceUrls || []
    );


  const headers =
    supabaseHeaders(
      env
    );


  // ----------------------------------------------------------
  // Find existing field.
  // ----------------------------------------------------------

  const query =
    `${tableUrl(
      env,
      "business_knowledge"
    )}` +
    `?application_id=eq.${encodeURIComponent(
      applicationId
    )}` +
    `&field=eq.${encodeURIComponent(
      field
    )}` +
    `&select=id,data,source_urls`;


  const response =
    await fetch(
      query,
      {
        headers
      }
    );


  if (!response.ok) {

    throw new Error(
      `Failed to query business_knowledge: ${await response.text()}`
    );
  }


  const existingRows =
    await response.json();


  const now =
    new Date().toISOString();


  if (
    existingRows.length
  ) {

    const row =
      existingRows[0];


    const mergedData =
      mergeValues(
        row.data,
        item.data
      );


    const mergedUrls =
      uniqueStrings([
        ...(Array.isArray(
          row.source_urls
        )
          ? row.source_urls
          : []),

        ...sourceUrls
      ]);


    const update =
      await fetch(
        `${tableUrl(
          env,
          "business_knowledge"
        )}` +
        `?id=eq.${encodeURIComponent(
          row.id
        )}`,
        {
          method: "PATCH",

          headers: {
            ...headers,
            Prefer:
              "return=minimal"
          },

          body:
            JSON.stringify({
              data:
                mergedData,

              source_urls:
                mergedUrls,

              updated_at:
                now
            })
        }
      );


    if (!update.ok) {

      throw new Error(
        `Failed to update business_knowledge: ${await update.text()}`
      );
    }


    return true;
  }


  // ----------------------------------------------------------
  // Insert.
  // ----------------------------------------------------------

  const insert =
    await fetch(
      tableUrl(
        env,
        "business_knowledge"
      ),
      {
        method: "POST",

        headers: {
          ...headers,
          Prefer:
            "return=minimal"
        },

        body:
          JSON.stringify({

            application_id:
              applicationId,

            field,

            data:
              item.data,

            source_urls:
              sourceUrls,

            created_at:
              now,

            updated_at:
              now
          })
      }
    );


  if (!insert.ok) {

    const errorText =
      await insert.text();


    // Another webhook may have inserted the same field
    // between SELECT and INSERT.
    if (
      insert.status === 409
    ) {

      return await saveKnowledge(
        env,
        applicationId,
        item
      );
    }


    throw new Error(
      `Failed to insert business_knowledge: ${errorText}`
    );
  }


  return true;
}


// ============================================================
// UPDATE BUSINESS DATA
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


  const response =
    await fetch(
      `${tableUrl(
        env,
        "business_data"
      )}` +
      `?id=eq.${encodeURIComponent(
        rowId
      )}`,
      {
        method: "PATCH",

        headers: {
          ...supabaseHeaders(env),
          Prefer:
            "return=minimal"
        },

        body:
          JSON.stringify({

            ai_status:
              status,

            ai_error:
              errorMessage || null,

            updated_at:
              new Date()
                .toISOString()
          })
      }
    );


  if (!response.ok) {

    console.error(
      "Failed to update business_data:",
      await response.text()
    );
  }
}


// ============================================================
// GENERIC HELPERS
// ============================================================

function normalizeText(
  value
) {

  return String(
    value
  )
    .replace(
      /\u00a0/g,
      " "
    )
    .replace(
      /\r/g,
      ""
    )
    .replace(
      /[ \t]+/g,
      " "
    )
    .trim();
}


function cleanString(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }


  return normalizeText(
    value
  );
}


function fingerprint(
  value
) {

  return normalizeText(
    value
  )
    .toLowerCase()
    .replace(
      /\s+/g,
      " "
    );
}


function normalizeFieldName(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }


  return String(value)
    .trim()
    .toLowerCase()
    .replace(
      /['"`]/g,
      ""
    )
    .replace(
      /&/g,
      " and "
    )
    .replace(
      /[^a-z0-9]+/g,
      "_"
    )
    .replace(
      /^_+|_+$/g,
      ""
    )
    .slice(
      0,
      150
    );
}


function looksLikeEmail(
  value
) {

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    .test(
      value.trim()
    );
}


function looksLikeUrl(
  value
) {

  try {

    const url =
      new URL(
        value.trim()
      );


    return (
      url.protocol ===
        "http:" ||
      url.protocol ===
        "https:"
    );

  } catch {

    return false;
  }
}


function looksLikePhone(
  value
) {

  const digits =
    value.replace(
      /\D/g,
      ""
    );


  return (
    digits.length >= 7 &&
    digits.length <= 15
  );
}


function looksLikeDate(
  value
) {

  const text =
    value.trim();


  if (
    /^\d{4}-\d{1,2}-\d{1,2}$/
      .test(text)
  ) {
    return true;
  }


  if (
    /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/
      .test(text)
  ) {
    return true;
  }


  if (
    /^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/
      .test(text)
  ) {
    return true;
  }


  if (
    /^[A-Za-z]+\s+\d{1,2},\s*\d{4}$/
      .test(text)
  ) {
    return true;
  }


  return false;
}


function uniqueStrings(
  values
) {

  return [
    ...new Set(
      values
        .filter(Boolean)
        .map(
          value =>
            String(value)
        )
    )
  ];
}


function uniqueObjectsAndStrings(
  values
) {

  const output = [];
  const seen = new Set();


  for (const value of values) {

    let key;


    if (
      value &&
      typeof value === "object"
    ) {

      try {

        key =
          JSON.stringify(
            value
          );

      } catch {

        key =
          String(value);
      }

    } else {

      key =
        String(value);
    }


    if (
      seen.has(key)
    ) {
      continue;
    }


    seen.add(key);
    output.push(value);
  }


  return output;
}


function isPlainObject(
  value
) {

  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}


function range(
  start,
  end
) {

  const result = [];


  for (
    let i = start;
    i < end;
    i++
  ) {

    result.push(i);
  }


  return result;
}


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
          "application/json"
      }
    }
  );
                  }
