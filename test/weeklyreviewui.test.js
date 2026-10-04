/*
 * The weekly coach review card, as the browser runs it.
 *
 * The page's own inline script is loaded in a stubbed environment. What matters here is that
 * every state is honest: a review that is out of date says so, a generating review cannot be
 * started twice, a failure leaves the lifter somewhere they can retry, and nothing the model
 * or the lifter wrote can inject markup.
 */
process.env.JWT_SECRET = 'weeklyreviewui-test-secret-long-enough-to-avoid-warnings';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { makeChecker } = require('./helpers/pgshim');
const ROOT = path.join(__dirname, '..');
const { check, report } = makeChecker();

function harness(fetchImpl) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const inline = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
        .sort((a, b) => b.length - a.length)[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
    const els = {};
    const el = id => els[id] || (els[id] = {
        innerHTML: '', innerText: '', textContent: '', value: '', className: '', dataset: {},
        classList: { add() {}, remove() {}, contains: () => false }, querySelector: () => null, scrollIntoView() {}
    });
    const calls = [];
    const ctx = {
        console, Date, JSON, Math, parseInt, Array, Object, String, Number, Set, Map, Promise,
        setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
        navigator: {}, window: { addEventListener() {} }, self: {}, alert: () => {}, confirm: () => true,
        fetch: async (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); },
        localStorage: { getItem: k => (k === 'token' ? 'tok' : null), setItem() {}, removeItem() {} },
        document: { addEventListener() {}, getElementById: el, querySelector: () => null, querySelectorAll: () => [] }
    };
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(inline, ctx);
    return { ctx, calls, box: () => el('weekly-review').innerHTML };
}

const ok = body => ({ ok: true, json: async () => body });
const bad = (status, body) => ({ ok: false, status, json: async () => body || {} });

const REVIEW = {
    headline: 'A solid week with one thing to watch',
    summary: 'You hit every session and added reps on bench.',
    week: 4,
    wins: [{ title: 'Bench reps up', detail: 'You added a rep on the first set.' }],
    watch: [
        { title: 'Left shoulder', detail: 'Press lighter until it settles.', kind: 'injury' },
        { title: 'Overhead press', detail: 'Three flat weeks.', kind: 'stall' },
        { title: 'Sleep', detail: 'You mentioned bad nights.', kind: 'fatigue' },
        { title: 'Something else', detail: 'Worth a look.', kind: 'other' }
    ],
    focus: [{ action: 'Press at 130 lb for 3 x 8', why: 'Keeps the habit while the shoulder settles.' }, { action: 'Add 5 lb to squat', why: 'Every set hit the top of the range.' }],
    personalRecords: [{ name: 'Back Squat', type: 'weight', weight: 205, reps: 5, previous: { weight: 195, reps: 5 } }],
    basedOn: { sessions: 3, notes: 2 },
    generatedAt: '2026-06-28T10:00:00Z'
};
const avail = (extra) => Object.assign({ available: true, reason: null, week: 4, totalWeeks: 6, sessions: 3, review: null, stale: false }, extra || {});

(async () => {
    const { ctx } = harness(async () => ok({}));
    const html = (state, ui) => ctx.weeklyReviewHtml(state, Object.assign({ busy: false, error: null }, ui || {}));

    console.log('\n=== before there is anything to show ===\n');
    check('loading', /Loading/.test(html(null)), true);
    check('a failed load says so and offers a retry', /Could not load/.test(html(null, { error: 'Could not load your weekly review' })) && /Retry/.test(html(null, { error: 'Could not load your weekly review' })), true);
    check('no cycle explains what to do', /Start a cycle and log a workout/.test(html({ available: false, reason: 'no_cycle' })), true);
    check('no sessions explains what to do', /Log a workout this week/.test(html({ available: false, reason: 'no_sessions', week: 3 })), true);
    check('nothing to review offers no button', /Get my review/.test(html({ available: false, reason: 'no_sessions' })), false);

    console.log('\n=== ready to write ===\n');
    let out = html(avail());
    check('invites the lifter to ask', /Get my review/.test(out), true);
    check('says how much it will read', /3 sessions/.test(out), true);
    check('one session is singular', /1 session /.test(html(avail({ sessions: 1 }))), true);
    check('names the week', /Week 4/.test(out), true);
    out = html(avail(), { busy: true });
    check('while writing it says so', /Your coach is reviewing your week/.test(out), true);
    check('and the button is disabled', /<button[^>]*disabled/.test(out), true);
    check('a failed attempt shows why and keeps the button', /Please try again/.test(html(avail(), { error: 'Your coach could not write this review. Please try again.' })) && /Get my review/.test(html(avail(), { error: 'x' })), true);

    console.log('\n=== the review ===\n');
    out = html(avail({ review: REVIEW }));
    check('headline', out.includes(REVIEW.headline), true);
    check('summary', out.includes(REVIEW.summary), true);
    check('wins section', /What went well/.test(out) && out.includes('Bench reps up'), true);
    check('watch section', /Keep an eye on/.test(out) && out.includes('Left shoulder'), true);
    check('focus section is numbered', /Focus next week/.test(out) && (out.match(/class="wr-num">(\d)</g) || []).join('') .replace(/\D/g, '') === '12', true);
    check('a record is shown with what it beat', /PR<\/span>/.test(out) && out.includes('205 lb × 5 (was 195)'), true);
    check('injury and stall get the warning style', (out.match(/wr-tag wr-tag-hot/g) || []).length, 2);
    check('fatigue gets a quiet tag', />Fatigue</.test(out) && !/wr-tag-hot">Fatigue/.test(out), true);
    check('"other" gets no tag', /Something else<\/div>/.test(out), true);
    check('says what it was based on', out.includes('Based on 3 sessions and 2 notes'), true);
    check('includes the not-medical-advice note', /not medical advice/.test(out), true);
    check('a current review offers a quiet refresh', /wr-link/.test(out) && !/Update review/.test(out), true);
    check('and no stale banner', /wr-stale/.test(out), false);

    const bare = html(avail({ review: Object.assign({}, REVIEW, { personalRecords: [], wins: [], watch: [] }) }));
    check('with no records there is no records block', /class="wr-prs"/.test(bare), false);
    check('with no wins or concerns those sections are omitted', !/What went well/.test(bare) && !/Keep an eye on/.test(bare), true);
    check('focus is always there', /Focus next week/.test(bare), true);

    console.log('\n=== describing a record ===\n');
    const label = ctx.reviewPrLabel;
    check('heavier weight', label({ type: 'weight', weight: 205, reps: 5, previous: { weight: 195 } }), '205 lb × 5 (was 195)');
    check('more reps at a weight', label({ type: 'reps', weight: 135, reps: 9, previous: { reps: 8 } }), '9 reps at 135 lb (was 8)');
    check('bodyweight reps', label({ type: 'reps', weight: null, reps: 12, previous: { reps: 10 } }), '12 reps (was 10)');
    check('better estimated max', label({ type: 'e1rm', e1rm: 234.3, previous: { e1rm: 221.6 } }), 'est. max 234 lb (was 222)');

    console.log('\n=== out of date ===\n');
    out = html(avail({ review: REVIEW, stale: true }));
    check('says more has been logged', /logged more since this was written/.test(out), true);
    check('offers to update', /Update review/.test(out), true);
    check('the quiet refresh link is replaced by it', /class="wr-link"/.test(out), false);
    check('updating disables the button', /<button[^>]*disabled/.test(html(avail({ review: REVIEW, stale: true }), { busy: true })), true);

    console.log('\n=== untrusted text ===\n');
    const evil = '<img src=x onerror=alert(1)>';
    out = html(avail({ review: Object.assign({}, REVIEW, {
        headline: evil, summary: evil, wins: [{ title: evil, detail: evil }],
        watch: [{ title: evil, detail: evil, kind: 'injury' }], focus: [{ action: evil, why: evil }],
        personalRecords: [{ name: evil, type: 'weight', weight: 1, reps: 1, previous: { weight: 0 } }]
    }) }));
    check('nothing from the model can inject markup', out.includes('<img src=x'), false);
    check('it is shown as text instead', out.includes('&lt;img src=x onerror=alert(1)&gt;'), true);
    check('an error message is escaped too', html(avail(), { error: evil }).includes('<img'), false);

    console.log('\n=== loading it ===\n');
    let h = harness(async () => ok(avail({ review: REVIEW })));
    await h.ctx.loadWeeklyReview();
    check('opening the Journal fetches the review', h.calls[0].url, '/api/weekly-review');
    check('with the user\'s token', h.calls[0].opts.headers.Authorization, 'Bearer tok');
    check('and draws it', h.box().includes(REVIEW.headline), true);
    check('reading it made no POST', h.calls.every(c => !c.opts || !c.opts.method || c.opts.method === 'GET'), true);

    h = harness(async () => bad(500));
    await h.ctx.loadWeeklyReview();
    check('a failed load shows an error and a retry', /Could not load/.test(h.box()) && /Retry/.test(h.box()), true);

    console.log('\n=== asking for a review ===\n');
    const releases = [];
    let seen = '';
    h = harness(async (url, opts) => {
        if (opts && opts.method === 'POST') { await new Promise(r => releases.push(r)); return ok(avail({ review: REVIEW })); }
        return ok(avail());
    });
    await h.ctx.loadWeeklyReview();
    check('starts at the invitation', /Get my review/.test(h.box()), true);
    const pending = h.ctx.requestWeeklyReview();
    seen = h.box();
    check('while the coach writes, the card says so', /Your coach is reviewing your week/.test(seen), true);
    const extra = [h.ctx.requestWeeklyReview(), h.ctx.requestWeeklyReview()];
    await new Promise(r => setTimeout(r, 10));
    releases.forEach(r => r());          // release every request that was started, however many
    await Promise.all([pending, ...extra]);
    check('pressing again while it works does not start a second request', h.calls.filter(c => c.opts && c.opts.method === 'POST').length, 1);
    check('the request is authenticated', h.calls.find(c => c.opts && c.opts.method === 'POST').opts.headers.Authorization, 'Bearer tok');
    check('the finished review replaces the invitation', h.box().includes(REVIEW.headline) && !/Get my review/.test(h.box()), true);

    h = harness(async (url, opts) => (opts && opts.method === 'POST' ? bad(500, { error: 'Your coach could not write this review. Please try again in a moment.' }) : ok(avail())));
    await h.ctx.loadWeeklyReview();
    await h.ctx.requestWeeklyReview();
    check('a failed request shows the server\'s message', /could not write this review/.test(h.box()), true);
    check('and leaves the button to try again', /Get my review/.test(h.box()) && !/disabled/.test(h.box()), true);

    h = harness(async (url, opts) => (opts && opts.method === 'POST' ? bad(429, { error: 'Daily limit for AI generations reached.' }) : ok(avail({ review: REVIEW }))));
    await h.ctx.loadWeeklyReview();
    await h.ctx.requestWeeklyReview();
    check('a rate limit is explained, and the old review stays', /Daily limit/.test(h.box()) && h.box().includes(REVIEW.headline), true);

    console.log('\n=== opening the Journal ===\n');
    h = harness(async () => ok(avail()));
    let navError = null;
    try { h.ctx.nav('screen-journal', 'nav-journal'); } catch (e) { navError = e.message; }
    await new Promise(r => setTimeout(r, 20));
    check('navigating to the Journal does not throw', navError, null);
    check('and loads the review', h.calls.some(c => c.url === '/api/weekly-review'), true);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
