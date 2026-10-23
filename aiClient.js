// Claude access for the generation endpoints.
//
// Uses the Claude Agent SDK, which runs the machine's own signed-in Claude (no API key). The
// SDK is ESM, so it is loaded with a cached dynamic import() from this CommonJS file.
//
// Previously each endpoint inlined its own call and did:
//     if (text.startsWith('```json')) text = text.replace(...)
//     JSON.parse(text.trim())
// which failed whenever the model emitted a prose preamble, leading whitespace, or trailing
// commentary — and failed again, unrecoverably, because there was no retry and no validation.
// A syntactically valid object missing `days` was accepted and persisted as the user's plan.
//
// Three layers now, outermost first:
//   1. the prompt carries the JSON schema and the system prompt demands only that object,
//      removing the problem at source rather than cleaning up after it.
//   2. extractJsonObject finds the first balanced {...} regardless of surrounding text,
//      for the case where layer 1 is ignored.
//   3. a validator rejects structurally valid but useless responses, and one retry follows.
const config = require('./config');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_TIMEOUT_MS = 120 * 1000;

// Every built-in tool is switched off: this is a text-in, JSON-out call, and a model that can
// run Bash or read files has no business in a request handler.
const DISALLOWED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'ExitPlanMode'];

const SYSTEM_PROMPT = 'You return only a single JSON object that conforms to the JSON schema given in the user message. '
    + 'No markdown fences, no commentary before or after, no tool use.';

let sdkPromise = null;
let queryOverride = null;
let timeoutMs = DEFAULT_TIMEOUT_MS;

function modelName() {
    return process.env.CLAUDE_MODEL || DEFAULT_MODEL;
}

async function getQuery() {
    if (queryOverride) return queryOverride;
    if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk');
    const sdk = await sdkPromise;
    return sdk.query;
}

// Test seams: inject a stand-in for the SDK's query() (an async generator of messages), and
// shorten the per-call timeout.
function __setQueryForTests(fn, opts) {
    queryOverride = fn;
    timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
}

function readModelText(text) {
    if (typeof text !== 'string' || text.trim() === '') {
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
    const query = await getQuery();
    const fullPrompt = schema
        ? prompt + '\n\nReturn ONLY a JSON object that conforms to this JSON schema:\n' + JSON.stringify(schema)
        : prompt;

    const abort = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
            abort.abort();
            reject(new Error('Claude did not answer within ' + Math.round(timeoutMs / 1000) + ' seconds'));
        }, timeoutMs);
    });

    const stream = query({
        prompt: fullPrompt,
        options: {
            model: modelName(),
            systemPrompt: SYSTEM_PROMPT,
            allowedTools: [],
            disallowedTools: DISALLOWED_TOOLS,
            maxTurns: 1,
            settingSources: [],
            persistSession: false,
            abortController: abort
        }
    });
    const iterator = stream[Symbol.asyncIterator]();

    const readResult = (async () => {
        let result = null;
        for (;;) {
            const step = await iterator.next();
            if (step.done) break;
            if (step.value && step.value.type === 'result') result = step.value;
        }
        if (!result) throw new Error('Claude returned no result');
        if (result.is_error || (result.subtype && result.subtype !== 'success')) {
            throw new Error('Claude reported an error: ' + (typeof result.result === 'string' && result.result ? result.result : result.subtype || 'unknown'));
        }
        return result.result;
    })();

    try {
        return await Promise.race([readResult, timedOut]);
    } finally {
        clearTimeout(timer);
        readResult.catch(() => {});
        try { if (iterator.return) iterator.return().catch(() => {}); } catch (e) { /* already finished */ }
    }
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
            const text = readModelText(await callModel(prompt, schema));

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
    modelName,
    __setQueryForTests
};
