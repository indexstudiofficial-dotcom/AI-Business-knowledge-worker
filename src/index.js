// ============================================================
// REPORTLI BUSINESS AI ANALYZER
// VERSION: 2026-09-27-V1
//
// FLOW:
//
// Supabase Webhook
//       ↓
// Cloudflare Worker
//       ↓
// Cloudflare Queue
//       ↓
// Read business_data
//       ↓
// Sarvam AI
//       ↓
// Deduplicate fields
//       ↓
// business_knowledge
//       ↓
// business_data.ai_status = completed
//
// NO RAW DATA IS DELETED.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const SARVAM_MODEL = "sarvam-105b";

const SARVAM_URL =
    "https://api.sarvam.ai/v1/chat/completions";

const MAX_TEXT_CHARS = 100000;

const MAX_RETRIES = 5;

const RETRY_DELAY_SECONDS = 60;


// ============================================================
// MAIN WORKER
// ============================================================

export default {

    // ========================================================
    // SUPABASE WEBHOOK
    // ========================================================

    async fetch(request, env) {

        try {

            if (request.method !== "POST") {

                return json({
                    success: false,
                    error: "Only POST is allowed."
                }, 405);
            }


            // ------------------------------------------------
            // CHECK ENVIRONMENT
            // ------------------------------------------------

            requireEnvironment(env);


            // ------------------------------------------------
            // READ SUPABASE WEBHOOK
            // ------------------------------------------------

            const webhook =
                await request.json();


            // ------------------------------------------------
            // SUPABASE WEBHOOK FORMAT
            //
            // record contains the newly inserted row.
            // ------------------------------------------------

            const record =
                webhook.record ||
                webhook.new_record ||
                null;


            if (!record) {

                return json({
                    success: false,
                    error:
                        "Supabase webhook record is missing."
                }, 400);
            }


            const rowId =
                String(record.id || "").trim();


            const applicationId =
                String(
                    record.application_id || ""
                ).trim();


            if (!rowId) {

                return json({
                    success: false,
                    error:
                        "business_data.id is missing."
                }, 400);
            }


            if (!applicationId) {

                return json({
                    success: false,
                    error:
                        "application_id is missing."
                }, 400);
            }


            // ------------------------------------------------
            // ONLY ANALYZE PAGE ROWS
            // ------------------------------------------------

            const field =
                String(
                    record.field || ""
                ).trim();


            if (field !== "page") {

                return json({
                    success: true,
                    ignored: true,
                    reason:
                        "Only field=page is analyzed."
                });
            }


            // ------------------------------------------------
            // ONLY PROCESS PENDING ROWS
            // ------------------------------------------------

            const aiStatus =
                String(
                    record.ai_status || "pending"
                ).trim();


            if (aiStatus !== "pending") {

                return json({
                    success: true,
                    ignored: true,
                    reason:
                        `ai_status is ${aiStatus}.`
                });
            }


            // ------------------------------------------------
            // SEND ROW ID TO QUEUE
            //
            // We send only the ID.
            //
            // The queue will read the latest row from
            // Supabase instead of trusting the webhook body.
            // ------------------------------------------------

            await env.AI_ANALYSIS_QUEUE.send({

                business_data_id:
                    rowId,

                application_id:
                    applicationId

            });


            // ------------------------------------------------
            // RETURN IMMEDIATELY
            // ------------------------------------------------

            return json({

                success: true,

                queued: true,

                business_data_id:
                    rowId,

                application_id:
                    applicationId

            });


        } catch (error) {

            console.error(
                "WEBHOOK ERROR:",
                error
            );

            return json({

                success: false,

                error:
                    error.message

            }, 500);
        }
    },


    // ========================================================
    // CLOUDFLARE QUEUE CONSUMER
    // ========================================================

    async queue(batch, env) {

        for (
            const message
            of batch.messages
        ) {

            try {

                await processMessage(
                    message,
                    env
                );

            } catch (error) {

                console.error(
                    "QUEUE ERROR:",
                    error
                );


                // ------------------------------------------------
                // IF THIS IS THE FINAL ATTEMPT
                // ------------------------------------------------

                if (
                    message.attempts >=
                    MAX_RETRIES
                ) {

                    const body =
                        message.body || {};

                    const rowId =
                        body.business_data_id;


                    if (rowId) {

                        await updateBusinessDataStatus(
                            env,
                            rowId,
                            "failed",
                            error.message
                        );
                    }


                    // Don't retry anymore.
                    message.ack();

                    continue;
                }


                // ------------------------------------------------
                // RETRY AFTER 60 SECONDS
                // ------------------------------------------------

                message.retry({
                    delaySeconds:
                        RETRY_DELAY_SECONDS
                });
            }
        }
    }
};


// ============================================================
// PROCESS ONE BUSINESS_DATA ROW
// ============================================================

async function processMessage(
    message,
    env
) {

    const body =
        message.body || {};


    const rowId =
        String(
            body.business_data_id || ""
        ).trim();


    if (!rowId) {

        throw new Error(
            "Queue message is missing business_data_id."
        );
    }


    // --------------------------------------------------------
    // GET LATEST ROW FROM SUPABASE
    // --------------------------------------------------------

    const row =
        await getBusinessData(
            env,
            rowId
        );


    if (!row) {

        // Row was deleted.
        // Nothing to process.
        message.ack();

        return;
    }


    // --------------------------------------------------------
    // CHECK STATUS AGAIN
    //
    // This prevents duplicate processing if the webhook
    // fires more than once.
    // --------------------------------------------------------

    if (
        row.ai_status ===
        "completed"
    ) {

        message.ack();

        return;
    }


    // --------------------------------------------------------
    // ONLY PROCESS PAGE
    // --------------------------------------------------------

    if (
        row.field !== "page"
    ) {

        message.ack();

        return;
    }


    // --------------------------------------------------------
    // GET RAW TEXT
    // --------------------------------------------------------

    let rawText =
        extractRawText(
            row.data
        );


    if (!rawText) {

        throw new Error(
            "business_data.data is empty."
        );
    }


    // --------------------------------------------------------
    // LIMIT INPUT SIZE
    // --------------------------------------------------------

    if (
        rawText.length >
        MAX_TEXT_CHARS
    ) {

        rawText =
            rawText.slice(
                0,
                MAX_TEXT_CHARS
            );
    }


    // --------------------------------------------------------
    // MARK PROCESSING
    // --------------------------------------------------------

    await updateBusinessDataStatus(
        env,
        rowId,
        "processing"
    );


    // --------------------------------------------------------
    // SEND TO SARVAM
    // --------------------------------------------------------

    const analysis =
        await analyzeWithSarvam(
            env,
            rawText
        );


    // --------------------------------------------------------
    // SAVE EACH EXTRACTED FIELD
    // --------------------------------------------------------

    const fields =
        normalizeAIResult(
            analysis
        );


    if (
        fields.length === 0
    ) {

        throw new Error(
            "Sarvam returned no usable fields."
        );
    }


    // --------------------------------------------------------
    // SAVE / UPDATE BUSINESS KNOWLEDGE
    // --------------------------------------------------------

    for (
        const item of fields
    ) {

        await saveBusinessKnowledge(
            env,
            row.application_id,
            item.field,
            item.data
        );
    }


    // --------------------------------------------------------
    // MARK RAW PAGE AS COMPLETED
    // --------------------------------------------------------

    await updateBusinessDataStatus(
        env,
        rowId,
        "completed"
    );


    // --------------------------------------------------------
    // ACKNOWLEDGE QUEUE MESSAGE
    // --------------------------------------------------------

    message.ack();


    console.log(
        "AI ANALYSIS COMPLETED:",
        rowId
    );
}


// ============================================================
// GET BUSINESS_DATA ROW
// ============================================================

async function getBusinessData(
    env,
    rowId
) {

    const endpoint =
        `${env.SUPABASE_URL}` +
        `/rest/v1/business_data` +
        `?id=eq.${encodeURIComponent(rowId)}` +
        `&select=*`;


    const response =
        await fetch(
            endpoint,
            {
                headers: supabaseHeaders(env)
            }
        );


    if (!response.ok) {

        const text =
            await response.text();

        throw new Error(
            `Could not read business_data: ${text}`
        );
    }


    const rows =
        await response.json();


    return rows[0] || null;
}


// ============================================================
// EXTRACT RAW TEXT
// ============================================================

function extractRawText(data) {

    // --------------------------------------------------------
    // Current scraper saves data as plain text.
    // --------------------------------------------------------

    if (
        typeof data ===
        "string"
    ) {

        return data.trim();
    }


    // --------------------------------------------------------
    // Safety fallback if data was saved as JSON.
    // --------------------------------------------------------

    if (
        data &&
        typeof data ===
        "object"
    ) {

        if (
            typeof data.text ===
            "string"
        ) {

            return data.text.trim();
        }


        return JSON.stringify(
            data
        );
    }


    return "";
}


// ============================================================
// SARVAM AI
// ============================================================

async function analyzeWithSarvam(
    env,
    rawText
) {

    const systemPrompt = `You are a business information extraction system.

Your job is to extract REAL business information from website text.

IMPORTANT RULES:

1. Do not invent information.
2. Do not guess missing information.
3. Ignore obvious template/demo content.
4. Ignore placeholder content such as Lorem ipsum.
5. Ignore generic website navigation menus when they do not provide business information.
6. Ignore repeated headers and footers unless they contain useful real business information.
7. Only extract information that can reasonably belong to the business.
8. If information is uncertain, do not include it.
9. Deduplicate repeated information.
10. Return structured JSON only.
11. Use simple field names.
12. Each field must contain one clean value or a clean JSON array/object.
13. Do not create duplicate field names.

Useful fields include:

business_profile
business_name
business_type
description
services
products
contact
phone
email
address
location
hours
team
about
appointments
pricing
social_media
faqs

Only return fields that are actually supported by the text.`;


    const userPrompt =
        `Analyze the following website page text.

Return a JSON object where each key is a field name
and each value is the extracted business information.

Example:

{
  "business_name": "Example Dental Clinic",
  "business_type": "Dental Clinic",
  "services": [
    "Root Canal Treatment",
    "Tooth Extraction"
  ],
  "phone": "+91 1234567890",
  "address": "Palakkad, Kerala"
}

Website page text:

${rawText}`;


    const response =
        await fetch(
            SARVAM_URL,
            {
                method: "POST",

                headers: {

                    // Sarvam supports API key authentication
                    // using api-subscription-key.
                    "api-subscription-key":
                        env.SARVAM_API_KEY,

                    "Content-Type":
                        "application/json"
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

                    temperature:
                        0.1,

                    response_format: {
                        type:
                            "json_object"
                    },

                    max_tokens:
                        4096
                })
            }
        );


    // --------------------------------------------------------
    // RATE LIMIT
    // --------------------------------------------------------

    if (
        response.status ===
        429
    ) {

        throw new RateLimitError(
            "Sarvam rate limit reached."
        );
    }


    // --------------------------------------------------------
    // TEMPORARY SERVER ERROR
    // --------------------------------------------------------

    if (
        response.status ===
        500 ||
        response.status ===
        502 ||
        response.status ===
        503
    ) {

        throw new Error(
            `Sarvam temporary error: HTTP ${response.status}`
        );
    }


    // --------------------------------------------------------
    // OTHER ERROR
    // --------------------------------------------------------

    if (!response.ok) {

        const errorText =
            await response.text();

        throw new Error(
            `Sarvam error HTTP ${response.status}: ${errorText}`
        );
    }


    const result =
        await response.json();


    // --------------------------------------------------------
    // GET MODEL TEXT
    // --------------------------------------------------------

    const content =
        result
            ?.choices?.[0]
            ?.message
            ?.content;


    if (!content) {

        throw new Error(
            "Sarvam returned empty content."
        );
    }


    // --------------------------------------------------------
    // PARSE JSON
    // --------------------------------------------------------

    try {

        return JSON.parse(
            content
        );

    } catch {

        // Sometimes models may return
        // ```json ... ```
        // even when JSON was requested.

        const cleaned =
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


        try {

            return JSON.parse(
                cleaned
            );

        } catch {

            throw new Error(
                "Sarvam returned invalid JSON."
            );
        }
    }
}


// ============================================================
// NORMALIZE AI RESULT
// ============================================================

function normalizeAIResult(
    result
) {

    if (
        !result ||
        typeof result !==
        "object" ||
        Array.isArray(result)
    ) {

        return [];
    }


    const map =
        new Map();


    for (
        const [
            rawField,
            value
        ]
        of Object.entries(result)
    ) {

        const field =
            normalizeFieldName(
                rawField
            );


        if (!field) {
            continue;
        }


        if (
            value ===
            null ||
            value ===
            undefined ||
            value ===
            ""
        ) {

            continue;
        }


        const cleanedValue =
            cleanValue(
                value
            );


        if (
            cleanedValue ===
            null
        ) {

            continue;
        }


        // ----------------------------------------------------
        // Prevent duplicate fields returned by AI.
        // ----------------------------------------------------

        if (
            map.has(field)
        ) {

            const oldValue =
                map.get(field);


            map.set(
                field,
                mergeValues(
                    oldValue,
                    cleanedValue
                )
            );

        } else {

            map.set(
                field,
                cleanedValue
            );
        }
    }


    return Array.from(
        map.entries()
    ).map(
        ([field, data]) => ({
            field,
            data
        })
    );
}


// ============================================================
// NORMALIZE FIELD NAME
// ============================================================

function normalizeFieldName(
    field
) {

    return String(
        field || ""
    )
        .trim()
        .toLowerCase()
        .replace(
            /[^a-z0-9_]+/g,
            "_"
        )
        .replace(
            /^_+|_+$/g,
            ""
        );
}


// ============================================================
// CLEAN AI VALUE
// ============================================================

function cleanValue(
    value
) {

    if (
        typeof value ===
        "string"
    ) {

        const cleaned =
            value.trim();


        if (
            !cleaned ||
            /^null$/i.test(
                cleaned
            ) ||
            /^unknown$/i.test(
                cleaned
            ) ||
            /^not available$/i.test(
                cleaned
            )
        ) {

            return null;
        }


        return cleaned;
    }


    if (
        Array.isArray(value)
    ) {

        const result = [];


        for (
            const item of value
        ) {

            const cleaned =
                cleanValue(
                    item
                );


            if (
                cleaned !==
                null
            ) {

                result.push(
                    cleaned
                );
            }
        }


        // ----------------------------------------------------
        // Remove duplicate array values.
        // ----------------------------------------------------

        return uniqueArray(
            result
        );
    }


    if (
        typeof value ===
        "object" &&
        value !== null
    ) {

        const output = {};


        for (
            const [
                key,
                item
            ]
            of Object.entries(value)
        ) {

            const cleaned =
                cleanValue(
                    item
                );


            if (
                cleaned !==
                null
            ) {

                output[key] =
                    cleaned;
            }
        }


        if (
            Object.keys(output)
                .length === 0
        ) {

            return null;
        }


        return output;
    }


    return value;
}


// ============================================================
// UNIQUE ARRAY
// ============================================================

function uniqueArray(
    values
) {

    const seen =
        new Set();

    const result = [];


    for (
        const value of values
    ) {

        const key =
            typeof value ===
            "object"
                ? JSON.stringify(
                    value
                )
                : String(
                    value
                )
                    .trim()
                    .toLowerCase();


        if (
            seen.has(key)
        ) {

            continue;
        }


        seen.add(key);

        result.push(
            value
        );
    }


    return result;
}


// ============================================================
// MERGE VALUES
// ============================================================

function mergeValues(
    oldValue,
    newValue
) {

    // --------------------------------------------------------
    // Both arrays
    // --------------------------------------------------------

    if (
        Array.isArray(
            oldValue
        ) &&
        Array.isArray(
            newValue
        )
    ) {

        return uniqueArray([
            ...oldValue,
            ...newValue
        ]);
    }


    // --------------------------------------------------------
    // Both objects
    // --------------------------------------------------------

    if (
        isObject(oldValue) &&
        isObject(newValue)
    ) {

        return {
            ...oldValue,
            ...newValue
        };
    }


    // --------------------------------------------------------
    // Otherwise keep the new clean value.
    // --------------------------------------------------------

    return newValue;
}


// ============================================================
// SAVE BUSINESS KNOWLEDGE
// ============================================================

async function saveBusinessKnowledge(
    env,
    applicationId,
    field,
    data
) {

    // --------------------------------------------------------
    // IMPORTANT:
    //
    // business_knowledge has:
    //
    // UNIQUE(application_id, field)
    //
    // Therefore:
    //
    // Existing field → UPDATE
    // New field      → INSERT
    // --------------------------------------------------------

    const endpoint =
        `${env.SUPABASE_URL}` +
        `/rest/v1/business_knowledge` +
        `?on_conflict=application_id,field`;


    const row = {

        application_id:
            applicationId,

        field:
            field,

        data:
            data,

        updated_at:
            new Date().toISOString()
    };


    const response =
        await fetch(
            endpoint,
            {
                method: "POST",

                headers: {

                    ...supabaseHeaders(
                        env
                    ),

                    "Content-Type":
                        "application/json",

                    "Prefer":
                        "resolution=merge-duplicates,return=minimal"
                },

                body:
                    JSON.stringify([
                        row
                    ])
            }
        );


    if (!response.ok) {

        const errorText =
            await response.text();

        throw new Error(
            `business_knowledge save failed: ${errorText}`
        );
    }
}


// ============================================================
// UPDATE RAW PAGE STATUS
// ============================================================

async function updateBusinessDataStatus(
    env,
    rowId,
    status,
    errorMessage = null
) {

    const endpoint =
        `${env.SUPABASE_URL}` +
        `/rest/v1/business_data` +
        `?id=eq.${encodeURIComponent(rowId)}`;


    const update = {

        ai_status:
            status,

        updated_at:
            new Date().toISOString()
    };


    // --------------------------------------------------------
    // Only send error information if your table has
    // an ai_error column.
    //
    // Currently we don't assume that column exists.
    // --------------------------------------------------------


    const response =
        await fetch(
            endpoint,
            {
                method: "PATCH",

                headers: {

                    ...supabaseHeaders(
                        env
                    ),

                    "Content-Type":
                        "application/json",

                    "Prefer":
                        "return=minimal"
                },

                body:
                    JSON.stringify(
                        update
                    )
            }
        );


    if (!response.ok) {

        const errorText =
            await response.text();

        throw new Error(
            `Could not update ai_status: ${errorText}`
        );
    }
}


// ============================================================
// ENVIRONMENT CHECK
// ============================================================

function requireEnvironment(
    env
) {

    if (
        !env.SUPABASE_URL
    ) {

        throw new Error(
            "SUPABASE_URL is missing."
        );
    }


    if (
        !env.SUPABASE_SERVICE_ROLE_KEY
    ) {

        throw new Error(
            "SUPABASE_SERVICE_ROLE_KEY is missing."
        );
    }


    if (
        !env.SARVAM_API_KEY
    ) {

        throw new Error(
            "SARVAM_API_KEY is missing."
        );
    }


    if (
        !env.AI_ANALYSIS_QUEUE
    ) {

        throw new Error(
            "AI_ANALYSIS_QUEUE binding is missing."
        );
    }
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

        "Accept":
            "application/json"
    };
}


// ============================================================
// RATE LIMIT ERROR
// ============================================================

class RateLimitError
    extends Error {

    constructor(
        message
    ) {

        super(
            message
        );

        this.name =
            "RateLimitError";
    }
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
                    "*"
            }
        }
    );
    }
