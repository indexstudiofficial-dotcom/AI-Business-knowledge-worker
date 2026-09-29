/**
 * Reportli AI — Business Knowledge Worker
 *
 * AI-FREE / RULE-BASED
 *
 * Flow:
 *
 * Scraper Worker
 *      ↓
 * business_data
 *      ↓
 * Supabase Database Webhook
 *      ↓
 * This Worker
 *      ↓
 * Rule-based extraction
 *      ↓
 * business_knowledge
 *
 * This Worker does NOT:
 * - scrape websites
 * - call Sarvam
 * - call OpenAI
 * - use any AI
 *
 * Required secrets:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 */

const MAX_TEXT_CHARS = 50000;

export default {
  async fetch(request, env, ctx) {
    // ---------------------------------------------------------
    // CORS / OPTIONS
    // ---------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // ---------------------------------------------------------
    // HEALTH CHECK
    // ---------------------------------------------------------

    if (request.method === "GET") {
      return json({
        ok: true,
        worker: "ai-free-business-knowledge-worker",
        message: "Worker is running",
      });
    }

    // ---------------------------------------------------------
    // ONLY POST
    // ---------------------------------------------------------

    if (request.method !== "POST") {
      return json(
        {
          ok: false,
          error: "Method not allowed",
        },
        405
      );
    }

    // ---------------------------------------------------------
    // CHECK ENVIRONMENT
    // ---------------------------------------------------------

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error("Missing Supabase environment variables");

      return json(
        {
          ok: false,
          error: "Worker is missing Supabase configuration",
        },
        500
      );
    }

    // ---------------------------------------------------------
    // READ WEBHOOK
    // ---------------------------------------------------------

    let payload;

    try {
      payload = await request.json();
    } catch (error) {
      console.error("Invalid JSON:", error);

      return json(
        {
          ok: false,
          error: "Invalid JSON",
        },
        400
      );
    }

    console.log("Webhook received");

    // ---------------------------------------------------------
    // EXTRACT BUSINESS_DATA RECORD
    // ---------------------------------------------------------

    const record = extractRecord(payload);

    if (!record) {
      console.error("Could not find business_data record");

      return json(
        {
          ok: false,
          error: "Could not find business_data record in webhook payload",
        },
        400
      );
    }

    console.log("business_data id:", record.id);
    console.log("application_id:", record.application_id);
    console.log("field:", record.field);

    // ---------------------------------------------------------
    // ONLY PROCESS PAGE DATA
    // ---------------------------------------------------------

    if (record.field !== "page") {
      console.log("Ignoring non-page field:", record.field);

      return json({
        ok: true,
        ignored: true,
        reason: "Only page fields are processed",
        id: record.id,
      });
    }

    // ---------------------------------------------------------
    // PROCESS
    // ---------------------------------------------------------

    try {
      const result = await processBusinessData(record, env);

      return json({
        ok: true,
        ...result,
      });
    } catch (error) {
      console.error(
        "Processing failed:",
        error?.stack || error?.message || String(error)
      );

      // Try to save the error back to business_data.
      try {
        await updateBusinessDataStatus(
          record.id,
          "failed",
          error?.message || String(error),
          env
        );
      } catch (statusError) {
        console.error(
          "Could not save error status:",
          statusError?.message || String(statusError)
        );
      }

      return json(
        {
          ok: false,
          error: error?.message || String(error),
          id: record.id,
        },
        500
      );
    }
  },
};

// ============================================================
// MAIN PROCESSOR
// ============================================================

async function processBusinessData(record, env) {
  if (!record.id) {
    throw new Error("business_data id is missing");
  }

  if (!record.application_id) {
    throw new Error("application_id is missing");
  }

  // ----------------------------------------------------------
  // MARK AS PROCESSING
  // ----------------------------------------------------------

  await updateBusinessDataStatus(
    record.id,
    "processing",
    null,
    env
  );

  // ----------------------------------------------------------
  // CONVERT RAW DATA INTO TEXT
  // ----------------------------------------------------------

  const rawText = extractAllText(record.data);

  if (!rawText.trim()) {
    throw new Error("business_data.data contains no usable text");
  }

  console.log("Raw text length:", rawText.length);

  // ----------------------------------------------------------
  // EXTRACT RULE-BASED KNOWLEDGE
  // ----------------------------------------------------------

  const extracted = extractKnowledge({
    data: record.data,
    text: rawText,
    sourceUrl: record.source_url || null,
  });

  console.log(
    "Extracted fields:",
    Object.keys(extracted)
  );

  // ----------------------------------------------------------
  // SAVE TO business_knowledge
  // ----------------------------------------------------------

  const fields = Object.entries(extracted);

  let savedCount = 0;

  for (const [field, data] of fields) {
    if (
      data === null ||
      data === undefined ||
      data === "" ||
      (Array.isArray(data) && data.length === 0)
    ) {
      continue;
    }

    await saveKnowledge({
      applicationId: record.application_id,
      field,
      data,
      sourceUrl: record.source_url || null,
      env,
    });

    savedCount++;
  }

  // ----------------------------------------------------------
  // MARK COMPLETED
  // ----------------------------------------------------------

  await updateBusinessDataStatus(
    record.id,
    "completed",
    null,
    env
  );

  return {
    processed: true,
    id: record.id,
    application_id: record.application_id,
    fields_found: fields.length,
    fields_saved: savedCount,
  };
}

// ============================================================
// WEBHOOK RECORD EXTRACTION
// ============================================================

function extractRecord(payload) {
  // Supabase Database Webhook normally sends the row directly.

  if (
    payload &&
    payload.id &&
    payload.application_id &&
    payload.field
  ) {
    return payload;
  }

  // Support common wrapped payload formats too.

  if (
    payload?.record?.id &&
    payload?.record?.application_id
  ) {
    return payload.record;
  }

  if (
    payload?.new_record?.id &&
    payload?.new_record?.application_id
  ) {
    return payload.new_record;
  }

  if (
    payload?.data?.record?.id &&
    payload?.data?.record?.application_id
  ) {
    return payload.data.record;
  }

  if (
    payload?.data?.new_record?.id &&
    payload?.data?.new_record?.application_id
  ) {
    return payload.data.new_record;
  }

  return null;
}

// ============================================================
// TEXT EXTRACTION
// ============================================================

function extractAllText(value, depth = 0) {
  if (depth > 10) {
    return "";
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractAllText(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }

  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, val]) => {
        const valueText = extractAllText(val, depth + 1);

        if (!valueText) {
          return "";
        }

        return `${key}: ${valueText}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

// ============================================================
// MAIN RULE ENGINE
// ============================================================

function extractKnowledge({ data, text, sourceUrl }) {
  const result = {};

  const cleanText = cleanTextValue(text);

  // ----------------------------------------------------------
  // 1. BUSINESS NAME
  // ----------------------------------------------------------

  const businessName = extractBusinessName(data, cleanText);

  if (businessName) {
    result.business_name = businessName;
  }

  // ----------------------------------------------------------
  // 2. DESCRIPTION
  // ----------------------------------------------------------

  const description = extractDescription(data, cleanText);

  if (description) {
    result.description = description;
  }

  // ----------------------------------------------------------
  // 3. LOCATION
  // ----------------------------------------------------------

  const location = extractLocation(data, cleanText);

  if (location) {
    result.location = location;
  }

  // ----------------------------------------------------------
  // 4. PHONE NUMBERS
  // ----------------------------------------------------------

  const phones = extractPhones(data, cleanText);

  if (phones.length > 0) {
    result.phone_numbers = phones;
  }

  // ----------------------------------------------------------
  // 5. EMAILS
  // ----------------------------------------------------------

  const emails = extractEmails(data, cleanText);

  if (emails.length > 0) {
    result.emails = emails;
  }

  // ----------------------------------------------------------
  // 6. ADDRESS
  // ----------------------------------------------------------

  const address = extractAddress(data, cleanText);

  if (address) {
    result.address = address;
  }

  // ----------------------------------------------------------
  // 7. SERVICES
  // ----------------------------------------------------------

  const services = extractServices(data, cleanText);

  if (services.length > 0) {
    result.services = services;
  }

  // ----------------------------------------------------------
  // 8. BOOKING URL
  // ----------------------------------------------------------

  const bookingUrl = extractBookingUrl(data, cleanText);

  if (bookingUrl) {
    result.booking_url = bookingUrl;
  }

  // ----------------------------------------------------------
  // 9. WHATSAPP
  // ----------------------------------------------------------

  const whatsapp = extractWhatsApp(data, cleanText);

  if (whatsapp) {
    result.whatsapp = whatsapp;
  }

  // ----------------------------------------------------------
  // 10. SOCIAL LINKS
  // ----------------------------------------------------------

  const socialLinks = extractSocialLinks(data, cleanText);

  if (Object.keys(socialLinks).length > 0) {
    result.social_links = socialLinks;
  }

  // ----------------------------------------------------------
  // 11. EXPERIENCE
  // ----------------------------------------------------------

  const experience = extractExperience(cleanText);

  if (experience) {
    result.experience = experience;
  }

  // ----------------------------------------------------------
  // 12. CUSTOMER COUNT
  // ----------------------------------------------------------

  const customers = extractMetric(
    cleanText,
    [
      "customers",
      "clients",
      "guests",
      "members",
    ]
  );

  if (customers !== null) {
    result.customers = customers;
  }

  // ----------------------------------------------------------
  // 13. STAFF / STYLIST COUNT
  // ----------------------------------------------------------

  const stylists = extractMetric(
    cleanText,
    [
      "stylists",
      "staff",
      "employees",
      "therapists",
      "doctors",
      "professionals",
    ]
  );

  if (stylists !== null) {
    result.stylists = stylists;
  }

  // ----------------------------------------------------------
  // 14. PAYMENT METHODS
  // ----------------------------------------------------------

  const paymentMethods = extractPaymentMethods(cleanText);

  if (paymentMethods.length > 0) {
    result.payment_methods = paymentMethods;
  }

  // ----------------------------------------------------------
  // 15. OPENING HOURS
  // ----------------------------------------------------------

  const openingHours = extractOpeningHours(cleanText);

  if (openingHours.length > 0) {
    result.opening_hours = openingHours;
  }

  // ----------------------------------------------------------
  // 16. SOURCE URL
  // ----------------------------------------------------------

  if (sourceUrl) {
    result.source_url = sourceUrl;
  }

  return result;
}

// ============================================================
// BUSINESS NAME
// ============================================================

function extractBusinessName(data, text) {
  // First use explicitly structured fields if the scraper
  // already provided them.

  const direct = findObjectValue(
    data,
    [
      "business_name",
      "businessName",
      "company_name",
      "companyName",
      "organization_name",
      "organizationName",
      "hotel_name",
      "hotelName",
      "brand_name",
      "brandName",
    ]
  );

  if (direct) {
    return cleanBusinessName(String(direct));
  }

  // Look for title.

  const title = findObjectValue(
    data,
    [
      "title",
      "page_title",
      "pageTitle",
    ]
  );

  if (title) {
    const name = cleanBusinessName(String(title));

    if (isUsableBusinessName(name)) {
      return name;
    }
  }

  // Look for common text patterns.

  const lines = getLines(text);

  for (const line of lines.slice(0, 20)) {
    const lower = line.toLowerCase();

    if (
      lower.includes("welcome to ")
    ) {
      const value = line
        .replace(/^welcome\s+to\s+/i, "")
        .trim();

      if (isUsableBusinessName(value)) {
        return cleanBusinessName(value);
      }
    }
  }

  // First line containing a likely business name.

  for (const line of lines.slice(0, 10)) {
    if (isUsableBusinessName(line)) {
      return cleanBusinessName(line);
    }
  }

  return null;
}

function cleanBusinessName(value) {
  let result = value
    .replace(/\s+/g, " ")
    .trim();

  // Remove common page-title suffixes.

  result = result
    .replace(/\s*[|•·]\s*(home|homepage)\s*$/i, "")
    .replace(/\s*[-|•·]\s*(home|homepage)\s*$/i, "")
    .trim();

  return result;
}

function isUsableBusinessName(value) {
  if (!value) return false;

  const lower = value.toLowerCase();

  const blocked = [
    "home",
    "welcome",
    "contact us",
    "about us",
    "services",
    "our services",
    "book appointment",
    "gallery",
    "menu",
    "navigation",
  ];

  if (blocked.includes(lower)) {
    return false;
  }

  if (value.length < 3) {
    return false;
  }

  if (value.length > 150) {
    return false;
  }

  return true;
}

// ============================================================
// DESCRIPTION
// ============================================================

function extractDescription(data, text) {
  const direct = findObjectValue(
    data,
    [
      "description",
      "about",
      "about_us",
      "aboutUs",
      "business_description",
      "businessDescription",
    ]
  );

  if (direct && typeof direct === "string") {
    return cleanTextValue(direct);
  }

  const lines = getLines(text);

  const headingIndex = findHeadingIndex(lines, [
    "about",
    "about us",
    "about-us",
    "welcome",
    "welcome to",
  ]);

  if (headingIndex >= 0) {
    const collected = [];

    for (
      let i = headingIndex + 1;
      i < Math.min(lines.length, headingIndex + 8);
      i++
    ) {
      const line = lines[i];

      if (isSectionHeading(line)) {
        break;
      }

      if (line.length >= 30) {
        collected.push(line);
      }
    }

    if (collected.length > 0) {
      return collected.join(" ").slice(0, 2000);
    }
  }

  return null;
}

// ============================================================
// LOCATION
// ============================================================

function extractLocation(data, text) {
  const direct = findObjectValue(
    data,
    [
      "location",
      "city",
      "town",
      "area",
      "addressLocality",
    ]
  );

  if (direct) {
    return String(direct).trim();
  }

  // Common title format:
  // Business Name | Pollachi

  const firstLines = getLines(text).slice(0, 5);

  for (const line of firstLines) {
    const parts = line.split("|");

    if (parts.length >= 2) {
      const last = parts[parts.length - 1].trim();

      if (
        last.length >= 2 &&
        last.length <= 80 &&
        !isGenericPageWord(last)
      ) {
        return last;
      }
    }
  }

  return null;
}

// ============================================================
// PHONES
// ============================================================

function extractPhones(data, text) {
  const values = [];

  collectObjectValues(
    data,
    [
      "phone",
      "phone_number",
      "phoneNumber",
      "telephone",
      "mobile",
      "mobile_number",
      "mobileNumber",
      "whatsapp",
    ],
    values
  );

  const textMatches = text.match(
    /(?:\+?\d[\d\s().-]{7,}\d)/g
  ) || [];

  values.push(...textMatches);

  return unique(
    values
      .map(normalizePhone)
      .filter((phone) => phone)
  );
}

function normalizePhone(value) {
  const original = String(value).trim();

  const digits = original.replace(/\D/g, "");

  if (digits.length < 8 || digits.length > 15) {
    return null;
  }

  return original;
}

// ============================================================
// EMAILS
// ============================================================

function extractEmails(data, text) {
  const values = [];

  collectObjectValues(
    data,
    [
      "email",
      "emails",
      "mail",
      "contact_email",
      "contactEmail",
    ],
    values
  );

  const matches =
    text.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
    ) || [];

  values.push(...matches);

  return unique(
    values
      .map((value) => String(value).trim().toLowerCase())
      .filter((value) => value.includes("@"))
  );
}

// ============================================================
// ADDRESS
// ============================================================

function extractAddress(data, text) {
  const direct = findObjectValue(
    data,
    [
      "address",
      "full_address",
      "fullAddress",
      "street_address",
      "streetAddress",
    ]
  );

  if (typeof direct === "string") {
    return cleanTextValue(direct);
  }

  if (direct && typeof direct === "object") {
    return direct;
  }

  const lines = getLines(text);

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (
      lower.includes("road") ||
      lower.includes("street") ||
      lower.includes("avenue") ||
      lower.includes("nagar") ||
      lower.includes("p.o") ||
      lower.includes("pin") ||
      lower.includes("postal")
    ) {
      if (line.length >= 15 && line.length <= 300) {
        return line;
      }
    }
  }

  return null;
}

// ============================================================
// SERVICES
// ============================================================

function extractServices(data, text) {
  const values = [];

  collectObjectValues(
    data,
    [
      "services",
      "service",
      "treatments",
      "treatment",
      "facilities",
      "offers",
    ],
    values
  );

  const structured = flattenToStrings(values);

  if (structured.length > 0) {
    return cleanList(structured);
  }

  // Find a "Services" section in plain text.

  const lines = getLines(text);

  const headingIndex = findHeadingIndex(lines, [
    "services",
    "our services",
    "services we offer",
    "what we offer",
    "treatments",
    "facilities",
  ]);

  if (headingIndex < 0) {
    return [];
  }

  const results = [];

  for (
    let i = headingIndex + 1;
    i < Math.min(lines.length, headingIndex + 20);
    i++
  ) {
    const line = lines[i];

    if (isSectionHeading(line)) {
      break;
    }

    if (
      line.length >= 2 &&
      line.length <= 100 &&
      !isGenericPageWord(line)
    ) {
      results.push(line);
    }
  }

  return cleanList(results);
}

// ============================================================
// BOOKING URL
// ============================================================

function extractBookingUrl(data, text) {
  const urls = extractUrlsFromObject(data);

  for (const url of urls) {
    if (
      /book|appointment|reservation|reserve|schedule/i.test(
        url
      )
    ) {
      return url;
    }
  }

  const textUrls = extractUrls(text);

  for (const url of textUrls) {
    if (
      /book|appointment|reservation|reserve|schedule/i.test(
        url
      )
    ) {
      return url;
    }
  }

  return null;
}

// ============================================================
// WHATSAPP
// ============================================================

function extractWhatsApp(data, text) {
  const urls = extractUrlsFromObject(data);

  for (const url of urls) {
    if (
      /wa\.me|whatsapp\.com/i.test(url)
    ) {
      return url;
    }
  }

  const textUrls = extractUrls(text);

  for (const url of textUrls) {
    if (
      /wa\.me|whatsapp\.com/i.test(url)
    ) {
      return url;
    }
  }

  if (/book on whatsapp/i.test(text)) {
    const phones = extractPhones(data, text);

    if (phones.length > 0) {
      return phones[0];
    }
  }

  return null;
}

// ============================================================
// SOCIAL LINKS
// ============================================================

function extractSocialLinks(data, text) {
  const urls = unique([
    ...extractUrlsFromObject(data),
    ...extractUrls(text),
  ]);

  const result = {};

  for (const url of urls) {
    const lower = url.toLowerCase();

    if (lower.includes("instagram.com")) {
      result.instagram = url;
    } else if (lower.includes("facebook.com")) {
      result.facebook = url;
    } else if (
      lower.includes("linkedin.com")
    ) {
      result.linkedin = url;
    } else if (
      lower.includes("youtube.com") ||
      lower.includes("youtu.be")
    ) {
      result.youtube = url;
    } else if (
      lower.includes("twitter.com") ||
      lower.includes("x.com")
    ) {
      result.twitter = url;
    } else if (
      lower.includes("tiktok.com")
    ) {
      result.tiktok = url;
    }
  }

  return result;
}

// ============================================================
// EXPERIENCE
// ============================================================

function extractExperience(text) {
  const patterns = [
    /(\d+)\s*\+?\s*years?\s+(?:of\s+)?(?:experience|expertise)/i,
    /(\d+)\s*\+?\s*years?\s+(?:in|of)/i,
    /(?:over|more than)\s+(\d+)\s+years?/i,
    /(\d+)\s*years?\s+(?:traditional|rich)\s+experience/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      return `${match[1]} years`;
    }
  }

  return null;
}

// ============================================================
// NUMBER METRICS
// ============================================================

function extractMetric(text, keywords) {
  for (const keyword of keywords) {
    const escaped = escapeRegex(keyword);

    const patterns = [
      new RegExp(
        `(\\d[\\d,]*)\\s*\\+?\\s*${escaped}`,
        "i"
      ),
      new RegExp(
        `${escaped}\\s*[:\\-]?\\s*(\\d[\\d,]*)`,
        "i"
      ),
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);

      if (match) {
        const number = Number(
          match[1].replace(/,/g, "")
        );

        if (Number.isFinite(number)) {
          return number;
        }
      }
    }
  }

  return null;
}

// ============================================================
// PAYMENT METHODS
// ============================================================

function extractPaymentMethods(text) {
  const methods = [];

  const known = [
    ["credit card", "credit card"],
    ["debit card", "debit card"],
    ["net banking", "net banking"],
    ["upi", "UPI"],
    ["paypal", "PayPal"],
    ["cash", "cash"],
  ];

  for (const [search, value] of known) {
    if (text.toLowerCase().includes(search)) {
      methods.push(value);
    }
  }

  return unique(methods);
}

// ============================================================
// OPENING HOURS
// ============================================================

function extractOpeningHours(text) {
  const lines = getLines(text);
  const results = [];

  for (const line of lines) {
    if (
      /\b(mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday)\b/i.test(
        line
      ) &&
      /\d{1,2}[:.]\d{2}/.test(line)
    ) {
      results.push(line);
    }
  }

  return unique(results);
}

// ============================================================
// OBJECT HELPERS
// ============================================================

function findObjectValue(object, keys) {
  const wanted = new Set(
    keys.map((key) => key.toLowerCase())
  );

  function search(value, depth = 0) {
    if (depth > 10 || value === null || value === undefined) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = search(item, depth + 1);

        if (found !== null && found !== undefined) {
          return found;
        }
      }

      return null;
    }

    if (typeof value !== "object") {
      return null;
    }

    for (const [key, child] of Object.entries(value)) {
      if (
        wanted.has(key.toLowerCase()) &&
        child !== null &&
        child !== undefined &&
        child !== ""
      ) {
        return child;
      }
    }

    for (const child of Object.values(value)) {
      const found = search(child, depth + 1);

      if (found !== null && found !== undefined) {
        return found;
      }
    }

    return null;
  }

  return search(object);
}

function collectObjectValues(object, keys, output) {
  const wanted = new Set(
    keys.map((key) => key.toLowerCase())
  );

  function walk(value, depth = 0) {
    if (depth > 10 || value === null || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }

      return;
    }

    if (typeof value !== "object") {
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase())) {
        output.push(child);
      }

      walk(child, depth + 1);
    }
  }

  walk(object);
}

function flattenToStrings(value) {
  const result = [];

  function walk(item, depth = 0) {
    if (depth > 10 || item === null || item === undefined) {
      return;
    }

    if (typeof item === "string") {
      const value = cleanTextValue(item);

      if (value) {
        result.push(value);
      }

      return;
    }

    if (
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      result.push(String(item));
      return;
    }

    if (Array.isArray(item)) {
      for (const child of item) {
        walk(child, depth + 1);
      }

      return;
    }

    if (typeof item === "object") {
      for (const child of Object.values(item)) {
        walk(child, depth + 1);
      }
    }
  }

  walk(value);

  return result;
}

// ============================================================
// URL HELPERS
// ============================================================

function extractUrls(text) {
  const matches =
    text.match(
      /https?:\/\/[^\s"'<>]+/gi
    ) || [];

  return unique(
    matches.map((url) =>
      url.replace(/[),.;]+$/, "")
    )
  );
}

function extractUrlsFromObject(data) {
  const text = extractAllText(data);

  return extractUrls(text);
}

// ============================================================
// TEXT HELPERS
// ============================================================

function cleanTextValue(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function getLines(text) {
  return String(text)
    .split("\n")
    .map((line) =>
      line
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

function findHeadingIndex(lines, headings) {
  const normalized = headings.map((value) =>
    value.toLowerCase()
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase().trim();

    if (normalized.includes(line)) {
      return i;
    }
  }

  return -1;
}

function isSectionHeading(line) {
  const value = line.toLowerCase().trim();

  const headings = [
    "home",
    "about",
    "about us",
    "services",
    "our services",
    "contact",
    "contact us",
    "gallery",
    "facilities",
    "location",
    "menu",
    "book appointment",
    "booking",
    "offers",
    "events",
    "rooms",
    "dining",
  ];

  return headings.includes(value);
}

function isGenericPageWord(value) {
  const lower = value.toLowerCase().trim();

  return [
    "home",
    "about",
    "about us",
    "contact",
    "contact us",
    "services",
    "our services",
    "gallery",
    "menu",
    "booking",
    "book appointment",
    "login",
    "register",
  ].includes(lower);
}

function cleanList(values) {
  return unique(
    values
      .map((value) =>
        String(value)
          .replace(/^[•\-–—*]+\s*/, "")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter((value) => {
        return (
          value.length >= 2 &&
          value.length <= 150 &&
          !isGenericPageWord(value)
        );
      })
  );
}

function unique(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const key = String(value).toLowerCase().trim();

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
}

function escapeRegex(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

// ============================================================
// SUPABASE
// ============================================================

function supabaseHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function updateBusinessDataStatus(
  id,
  status,
  errorMessage,
  env
) {
  const url =
    `${env.SUPABASE_URL}/rest/v1/business_data` +
    `?id=eq.${encodeURIComponent(id)}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(env),
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      ai_status: status,
      ai_error: errorMessage || null,
      updated_at: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Failed to update business_data status: ${response.status} ${body}`
    );
  }
}

// ============================================================
// SAVE KNOWLEDGE
// ============================================================

async function saveKnowledge({
  applicationId,
  field,
  data,
  sourceUrl,
  env,
}) {
  const existingUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
    `?application_id=eq.${encodeURIComponent(applicationId)}` +
    `&field=eq.${encodeURIComponent(field)}` +
    `&select=id,data,source_urls`;

  const existingResponse = await fetch(existingUrl, {
    method: "GET",
    headers: supabaseHeaders(env),
  });

  if (!existingResponse.ok) {
    const body = await existingResponse.text();

    throw new Error(
      `Failed to check existing knowledge: ${existingResponse.status} ${body}`
    );
  }

  const existingRows = await existingResponse.json();

  // ----------------------------------------------------------
  // EXISTING FIELD → UPDATE
  // ----------------------------------------------------------

  if (existingRows.length > 0) {
    const existing = existingRows[0];

    const mergedData = mergeKnowledgeData(
      existing.data,
      data
    );

    const sourceUrls = mergeSourceUrls(
      existing.source_urls,
      sourceUrl
    );

    const updateUrl =
      `${env.SUPABASE_URL}/rest/v1/business_knowledge` +
      `?id=eq.${encodeURIComponent(existing.id)}`;

    const updateResponse = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        ...supabaseHeaders(env),
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        data: mergedData,
        source_urls: sourceUrls,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!updateResponse.ok) {
      const body = await updateResponse.text();

      throw new Error(
        `Failed to update business_knowledge: ${updateResponse.status} ${body}`
      );
    }

    console.log(
      "Updated knowledge:",
      field
    );

    return;
  }

  // ----------------------------------------------------------
  // NEW FIELD → INSERT
  // ----------------------------------------------------------

  const insertUrl =
    `${env.SUPABASE_URL}/rest/v1/business_knowledge`;

  const insertResponse = await fetch(insertUrl, {
    method: "POST",
    headers: {
      ...supabaseHeaders(env),
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      application_id: applicationId,
      field,
      data,
      source_urls: sourceUrl
        ? [sourceUrl]
        : [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });

  if (insertResponse.ok) {
    console.log(
      "Inserted knowledge:",
      field
    );

    return;
  }

  // ----------------------------------------------------------
  // RACE CONDITION RETRY
  // ----------------------------------------------------------

  const body = await insertResponse.text();

  if (insertResponse.status === 409) {
    console.log(
      "Knowledge appeared during insert; retrying:",
      field
    );

    await saveKnowledge({
      applicationId,
      field,
      data,
      sourceUrl,
      env,
    });

    return;
  }

  throw new Error(
    `Failed to insert business_knowledge: ${insertResponse.status} ${body}`
  );
}

// ============================================================
// MERGE KNOWLEDGE
// ============================================================

function mergeKnowledgeData(oldData, newData) {
  if (
    Array.isArray(oldData) &&
    Array.isArray(newData)
  ) {
    return unique([
      ...oldData,
      ...newData,
    ]);
  }

  if (
    typeof oldData === "object" &&
    oldData !== null &&
    typeof newData === "object" &&
    newData !== null &&
    !Array.isArray(oldData) &&
    !Array.isArray(newData)
  ) {
    return {
      ...oldData,
      ...newData,
    };
  }

  // New data is more recent.
  return newData;
}

function mergeSourceUrls(existing, newUrl) {
  const urls = Array.isArray(existing)
    ? [...existing]
    : [];

  if (newUrl) {
    urls.push(newUrl);
  }

  return unique(urls);
}

// ============================================================
// RESPONSE HELPERS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json",
      },
    }
  );
        }
