// Stands in for the Claude Agent SDK's query(): an async generator of messages ending in a
// `result` message. `handler({ prompt, options })` returns the model text, or:
//   an Error                   -> thrown by query()
//   { isError: true, text }    -> a result message with is_error set
//   { noResult: true }         -> a stream that ends without a result message
//   { hang: true }             -> a stream that never ends (for the timeout)
function stubAI(ai, handler, opts) {
    const calls = [];
    ai.__setQueryForTests(({ prompt, options }) => (async function* () {
        calls.push({ prompt, options });
        const r = await handler({ prompt, options });
        if (r instanceof Error) throw r;
        yield { type: 'system', subtype: 'init' };
        if (r && r.hang) await new Promise(() => {});
        if (r && r.noResult) return;
        if (r && r.isError) {
            yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: r.text };
            return;
        }
        yield { type: 'result', subtype: 'success', is_error: false, result: r };
    })(), opts);
    return calls;
}

module.exports = { stubAI };
