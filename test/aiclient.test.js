/*
 * T2-1 — model response handling.
 *
 * Stubs the Claude Agent SDK's query(), so every case runs with no login and no network. Each malformed
 * response below either 500'd the old code or, worse, was accepted and persisted.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-long-enough-to-avoid-the-warning';

const path = require('path');
const ai = require(path.join(__dirname, '..', 'aiClient.js'));
const { stubAI } = require('./helpers/aistub');

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

// Returns the calls the stub receives. Successive payloads answer successive calls; a payload
// may be a string (the model text), an Error (thrown), or one of the shapes in helpers/aistub.
function stub(...payloads) {
    let i = 0;
    return stubAI(ai, async () => payloads[Math.min(i++, payloads.length - 1)], { timeoutMs: 400 });
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

    console.log('\n=== generateJSON end to end ===\n');

    let calls = stub(J);
    check('returns the parsed plan', (await ai.generateJSON(planArgs())).planName, 'Base Cycle');
    check('the schema is in the prompt', calls[0].prompt.includes('"required":["planName","days"]'), true);
    check('the original prompt is kept', calls[0].prompt.startsWith('p\n'), true);
    check('uses the default model', calls[0].options.model, 'claude-sonnet-5-5');
    check('no tools are allowed', calls[0].options.allowedTools, []);
    check('the dangerous ones are named as disallowed',
        ['Bash', 'Read', 'Write', 'Edit', 'WebFetch'].every(t => calls[0].options.disallowedTools.includes(t)), true);
    check('one turn only', calls[0].options.maxTurns, 1);
    check('no settings files are loaded', calls[0].options.settingSources, []);
    check('a system prompt demands only the JSON', /only a single JSON object/.test(calls[0].options.systemPrompt), true);

    process.env.CLAUDE_MODEL = 'claude-test-model';
    calls = stub(J);
    await ai.generateJSON(planArgs());
    check('CLAUDE_MODEL overrides the model', calls[0].options.model, 'claude-test-model');
    delete process.env.CLAUDE_MODEL;

    calls = stub('Sure! Here is your plan:\n```json\n' + J + '\n```\nEnjoy!');
    check('JSON wrapped in prose still parses', (await ai.generateJSON(planArgs())).planName, 'Base Cycle');

    // First response is junk, second is good: must retry rather than 500.
    calls = stub('I am unable to produce that.', J);
    check('retries after unparseable output', (await ai.generateJSON(planArgs())).planName, 'Base Cycle');
    check('retry made exactly 2 calls', calls.length, 2);

    // First response parses but is useless. The old code would have saved this as the plan.
    calls = stub('{"planName":"Empty","days":[]}', J);
    check('retries after failed validation', (await ai.generateJSON(planArgs())).planName, 'Base Cycle');
    check('validation retry made 2 calls', calls.length, 2);

    // Both attempts bad: must throw a descriptive error, not undefined.
    calls = stub('nope', 'still nope');
    let err = null;
    try { await ai.generateJSON(planArgs()); } catch (e) { err = e.message; }
    check('gives up after 2 attempts with a clear error', /No JSON object found/.test(err), true);
    check('and stopped at 2 calls', calls.length, 2);

    console.log('\n=== failures from Claude itself ===\n');

    calls = stub({ isError: true, text: 'rate limited' }, J);
    check('an is_error result is retried', (await ai.generateJSON(planArgs())).planName, 'Base Cycle');
    check('after exactly one retry', calls.length, 2);

    stub({ isError: true, text: 'not signed in' });
    err = null;
    try { await ai.generateJSON(planArgs()); } catch (e) { err = e.message; }
    check('a persistent is_error surfaces its reason', err, 'Claude reported an error: not signed in');

    stub({ noResult: true });
    err = null;
    try { await ai.generateJSON(planArgs()); } catch (e) { err = e.message; }
    check('a stream with no result is an error', err, 'Claude returned no result');

    stub('   ');
    err = null;
    try { await ai.generateJSON(planArgs()); } catch (e) { err = e.message; }
    check('an empty answer is an error', err, 'Model returned no text output');

    stub(new Error('spawn claude ENOENT'));
    err = null;
    try { await ai.generateJSON(planArgs()); } catch (e) { err = e.message; }
    check('a real outage still surfaces', err, 'spawn claude ENOENT');

    calls = stub({ hang: true }, J);
    const started = Date.now();
    check('a call that never answers times out and is retried', (await ai.generateJSON(planArgs())).planName, 'Base Cycle');
    check('the timeout was the short test one', Date.now() - started < 5000, true);
    check('the hung call was aborted', calls[0].options.abortController.signal.aborted, true);

    stub({ hang: true });
    err = null;
    try { await ai.generateJSON(planArgs()); } catch (e) { err = e.message; }
    check('repeated timeouts give a clear error', /did not answer within/.test(err), true);

    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
