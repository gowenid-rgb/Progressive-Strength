/*
 * T2-1 — model response handling.
 *
 * Injects a stub client, so every case runs with no API key and no network. Each malformed
 * response below either 500'd the old code or, worse, was accepted and persisted.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-long-enough-to-avoid-the-warning';

const path = require('path');
const ai = require(path.join(__dirname, '..', 'aiClient.js'));

let pass = 0, fail = 0;
function check(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { console.log('  PASS  ' + label); pass++; }
    else { console.log('  FAIL  ' + label + '\n        expected ' + e + '\n        actual   ' + a); fail++; }
}

const VALID_PLAN = {
    planName: 'Base Cycle',
    week: 1,
    days: [{ dayName: 'Push', exercises: [{ name: 'Bench Press', sets: 3, reps: '5' }] }]
};

// Returns a stub whose successive calls yield the given payloads. A payload may be a string
// (becomes output_text) or an Error (thrown).
function stub(...payloads) {
    const calls = [];
    let i = 0;
    ai.__setClientForTests({
        interactions: {
            create: async req => {
                calls.push(req);
                const p = payloads[Math.min(i++, payloads.length - 1)];
                if (p instanceof Error) throw p;
                return { output_text: p };
            }
        }
    });
    return calls;
}

const planArgs = extra => Object.assign({
    prompt: 'p', schema: ai.PLAN_SCHEMA, validate: ai.validatePlan, label: 'test'
}, extra);

(async () => {
    console.log('\n=== T2-1: extracting JSON from messy model output ===\n');

    const J = JSON.stringify(VALID_PLAN);

    check('plain JSON', JSON.parse(ai.extractJsonObject(J)).planName, 'Base Cycle');
    check('fenced with ```json', JSON.parse(ai.extractJsonObject('```json\n' + J + '\n```')).planName, 'Base Cycle');
    check('bare ``` fence', JSON.parse(ai.extractJsonObject('```\n' + J + '\n```')).planName, 'Base Cycle');

    // The old code used startsWith, so any leading whitespace or prose defeated it entirely.
    check('leading whitespace', JSON.parse(ai.extractJsonObject('\n\n   ' + J)).planName, 'Base Cycle');
    check('prose preamble', JSON.parse(ai.extractJsonObject('Sure! Here is your plan:\n' + J)).planName, 'Base Cycle');
    check('trailing commentary', JSON.parse(ai.extractJsonObject(J + '\n\nLet me know if you want changes!')).planName, 'Base Cycle');
    check('preamble AND fence AND trailer',
        JSON.parse(ai.extractJsonObject('Here you go:\n```json\n' + J + '\n```\nEnjoy!')).planName, 'Base Cycle');

    // Brace counting must respect strings, or a } inside an exercise name ends the object early.
    const braceName = { planName: 'A', days: [{ dayName: 'D', exercises: [{ name: 'Squat {3x5}', sets: 3, reps: '5' }] }] };
    check('braces inside a string value',
        JSON.parse(ai.extractJsonObject(JSON.stringify(braceName))).days[0].exercises[0].name, 'Squat {3x5}');
    check('escaped quote inside a string',
        JSON.parse(ai.extractJsonObject('{"planName":"the \\"big\\" cycle","days":[]}')).planName, 'the "big" cycle');

    check('no JSON at all returns null', ai.extractJsonObject('I cannot help with that.'), null);
    check('truncated JSON returns null', ai.extractJsonObject('{"planName":"x","days":[{'), null);
    check('non-string input returns null', ai.extractJsonObject(undefined), null);

    console.log('\n=== T2-1: validation rejects structurally valid junk ===\n');

    check('valid plan passes', ai.validatePlan(VALID_PLAN), null);
    check('missing days rejected', ai.validatePlan({ planName: 'x' }), 'days is not an array');
    check('empty days rejected', ai.validatePlan({ planName: 'x', days: [] }), 'days is empty');
    check('day with no exercises rejected',
        ai.validatePlan({ planName: 'x', days: [{ dayName: 'A', exercises: [] }] }), 'day 0 has no exercises');
    check('exercise with no name rejected',
        ai.validatePlan({ planName: 'x', days: [{ dayName: 'A', exercises: [{ sets: 3 }] }] }),
        'day 0 exercise 0 has no name');
    check('valid recap passes', ai.validateRecap({ recapTitle: 'T', recapMessage: 'M' }), null);
    check('recap missing message rejected', ai.validateRecap({ recapTitle: 'T' }), 'missing recapMessage');

    console.log('\n=== T2-1: generateJSON end to end ===\n');

    let calls = stub(J);
    check('returns the parsed plan', (await ai.generateJSON(planArgs())).planName, 'Base Cycle');
    check('sends response_format with the schema', calls[0].response_format.mime_type, 'application/json');
    check('response_format carries the schema', calls[0].response_format.schema.required, ['planName', 'days']);

    // First response is junk, second is good: must retry rather than 500.
    calls = stub('I am unable to produce that.', J);
    check('retries after unparseable output', (await ai.generateJSON(planArgs())).planName, 'Base Cycle');
    check('retry made exactly 2 calls', calls.length, 2);

    // First response parses but is useless. The old code would have saved this as the plan.
    calls = stub('{"planName":"Empty","days":[]}', J);
    check('retries after failed validation', (await ai.generateJSON(planArgs())).planName, 'Base Cycle');
    check('validation retry made 2 calls', calls.length, 2);

    // Both attempts bad: must throw a descriptive error, not undefined.
    stub('nope', 'still nope');
    let err = null;
    try { await ai.generateJSON(planArgs()); } catch (e) { err = e.message; }
    check('gives up after 2 attempts with a clear error', /No JSON object found/.test(err), true);

    // Missing output_text must not become undefined deep inside JSON.parse.
    ai.__setClientForTests({ interactions: { create: async () => ({ id: 'x' }) } });
    err = null;
    try { await ai.generateJSON(planArgs()); } catch (e) { err = e.message; }
    check('empty response gives a clear error', err, 'Model returned no text output');

    console.log('\n=== T2-1: response_format fallback ===\n');

    // If the API rejects response_format, degrade to a plain call rather than failing.
    const rejection = new Error('Unknown field: response_format');
    rejection.status = 400;
    calls = stub(rejection, J);
    const out = await ai.generateJSON(planArgs());
    check('falls back and still returns a plan', out.planName, 'Base Cycle');
    check('first call included response_format', 'response_format' in calls[0], true);
    check('fallback call omitted response_format', 'response_format' in calls[1], false);

    // Non-shape errors must propagate, not be swallowed by the fallback.
    const outage = new Error('503 Service Unavailable');
    outage.status = 503;
    stub(outage);
    err = null;
    try { await ai.generateJSON(planArgs()); } catch (e) { err = e.message; }
    check('a real API outage still surfaces', err, '503 Service Unavailable');

    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
