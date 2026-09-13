// Gemini access for the three generation endpoints.
//
// Previously each endpoint inlined its own call and did:
//     if (text.startsWith('```json')) text = text.replace(...)
//     JSON.parse(text.trim())
// which failed whenever the model emitted a prose preamble, leading whitespace, or trailing
// commentary — and failed again, unrecoverably, because there was no retry and no validation.
// A syntactically valid object missing `days` was accepted and persisted as the user's plan.
//
// Three layers now, outermost first:
//   1. response_format asks the API to guarantee schema-conforming JSON, removing the
//      problem at source rather than cleaning up after it.
//   2. extractJsonObject finds the first balanced {...} regardless of surrounding text,
//      for the case where layer 1 is unavailable or ignored.
//   3. a validator rejects structurally valid but useless responses, and one retry follows.
const { GoogleGenAI } = require('@google/genai');
const { GEMINI_API_KEY } = require('./config');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

let client = null;
// Set to false permanently if the API rejects the response_format field, so a single
// unsupported request does not cost every later call an extra round trip.
let responseFormatSupported = true;

function getClient() {
    if (!client) client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    return client;
}

// Test seam: inject a stub client and reset the capability flag.
function __setClientForTests(stub) {
    client = stub;
    responseFormatSupported = true;
}

// The SDK returns concatenated model text on `output_text` (snake_case). Earlier code read
// `outputText || output_text || text`; the first and third never exist on this type, so an
// SDK change would have produced undefined and thrown deep inside JSON.parse.
function readModelText(response) {
    const text = response && response.output_text;
    if (typeof text !== 'string' || text.trim() === '') {
        console.error('Unexpected model response shape. Keys:', Object.keys(response || {}));
        throw new Error('Model returned no text output');
    }
    return text;
}

// Returns the first balanced JSON object in `text`, or null.
//
// Brace counting rather than a regex, because a regex cannot match nested braces, and string
// awareness matters: a `}` inside "Deadlift (3x5) }" must not end the object. Handles markdown
// fences, prose preambles and trailing commentary without special-casing any of them.
function extractJsonObject(text) {
    if (typeof text !== 'string') return null;
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }

        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null; // unterminated — usually a truncated response
}

async function callModel(prompt, schema) {
    const request = { model: MODEL, input: prompt };

    if (schema && responseFormatSupported) {
        request.response_format = { type: 'text', mime_type: 'application/json', schema };
    }

    try {
        return await getClient().interactions.create(request);
    } catch (err) {
        // If the API rejects the request because of response_format, degrade to a plain call
        // rather than failing the user's request. Layers 2 and 3 still apply.
        if (request.response_format && isRequestShapeError(err)) {
            responseFormatSupported = false;
            console.warn('response_format rejected by the API; falling back to prompt-only JSON.', err.message);
            return await getClient().interactions.create({ model: MODEL, input: prompt });
        }
        throw err;
    }
}

function isRequestShapeError(err) {
    const msg = String((err && err.message) || '').toLowerCase();
    const status = err && (err.status || err.code);
    if (status === 400 || status === 'INVALID_ARGUMENT') return true;
    return msg.includes('response_format')
        || msg.includes('unknown field')
        || msg.includes('invalid argument')
        || msg.includes('unrecognized');
}

/**
 * Calls the model and returns a parsed, validated object.
 *
 * @param {string}   prompt
 * @param {object}   schema    JSON schema passed to the API (layer 1)
 * @param {function} validate  receives the parsed object; returns a problem string, or null
 * @param {string}   label     used in logs
 */
async function generateJSON({ prompt, schema, validate, label }) {
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await callModel(prompt, schema);
            const text = readModelText(response);

            const raw = extractJsonObject(text);
            if (!raw) {
                throw new Error('No JSON object found in model response (' + text.length + ' chars)');
            }

            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                throw new Error('Model returned malformed JSON: ' + e.message);
            }

            const problem = validate ? validate(parsed) : null;
            if (problem) throw new Error('Response failed validation: ' + problem);

            return parsed;
        } catch (err) {
            lastError = err;
            console.warn(`[${label}] attempt ${attempt}/2 failed: ${err.message}`);
        }
    }

    throw lastError;
}

/* ---------------------------------------------------------------- schemas */

const EXERCISE_SCHEMA = {
    type: 'object',
    properties: {
        name: { type: 'string' },
        sets: { type: 'integer' },
        reps: { type: 'string' },
        // Omitted entirely for warmups and unfamiliar movements. The prompts say to omit it
        // rather than send null, because a null would not satisfy `type: string`.
        suggestedWeight: { type: 'string' }
    },
    required: ['name', 'sets', 'reps']
};

const PLAN_SCHEMA = {
    type: 'object',
    properties: {
        planName: { type: 'string' },
        week: { type: 'integer' },
        days: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    dayName: { type: 'string' },
                    workoutIntro: { type: 'string' },
                    exercises: { type: 'array', items: EXERCISE_SCHEMA }
                },
                required: ['dayName', 'exercises']
            }
        }
    },
    required: ['planName', 'days']
};

const RECAP_SCHEMA = {
    type: 'object',
    properties: {
        recapTitle: { type: 'string' },
        recapMessage: { type: 'string' },
        stats: {
            type: 'array',
            items: {
                type: 'object',
                properties: { label: { type: 'string' }, value: { type: 'string' } },
                required: ['label', 'value']
            }
        }
    },
    required: ['recapTitle', 'recapMessage']
};

/* ------------------------------------------------------------ validators */

// Rejects responses that parse but would render a broken or empty screen. The old code had
// no equivalent: a valid object missing `days` was saved as the user's active plan.
function validatePlan(plan) {
    if (!plan || typeof plan !== 'object') return 'not an object';
    if (!Array.isArray(plan.days)) return 'days is not an array';
    if (plan.days.length === 0) return 'days is empty';

    for (let i = 0; i < plan.days.length; i++) {
        const day = plan.days[i];
        if (!day || typeof day !== 'object') return `day ${i} is not an object`;
        if (!Array.isArray(day.exercises)) return `day ${i} has no exercises array`;
        if (day.exercises.length === 0) return `day ${i} has no exercises`;
        for (let j = 0; j < day.exercises.length; j++) {
            const ex = day.exercises[j];
            if (!ex || typeof ex.name !== 'string' || ex.name.trim() === '') {
                return `day ${i} exercise ${j} has no name`;
            }
        }
    }
    return null;
}

function validateRecap(recap) {
    if (!recap || typeof recap !== 'object') return 'not an object';
    if (typeof recap.recapTitle !== 'string' || recap.recapTitle.trim() === '') return 'missing recapTitle';
    if (typeof recap.recapMessage !== 'string' || recap.recapMessage.trim() === '') return 'missing recapMessage';
    if (recap.stats !== undefined && !Array.isArray(recap.stats)) return 'stats is not an array';
    return null;
}

module.exports = {
    generateJSON,
    extractJsonObject,
    readModelText,
    validatePlan,
    validateRecap,
    PLAN_SCHEMA,
    RECAP_SCHEMA,
    MODEL,
    __setClientForTests
};
