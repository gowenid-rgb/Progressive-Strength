/*
 * The Metrics screen, as the browser runs it.
 *
 * The page's own inline script is loaded in a stubbed environment and fed the REAL output of
 * computeCycleSnapshot — not hand-written fixtures — so a change to the snapshot's shape that
 * the screen does not understand fails here rather than on someone's phone.
 */
process.env.JWT_SECRET = 'metricsui-test-secret-long-enough-to-avoid-warnings';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { makeChecker } = require('./helpers/pgshim');

const ROOT = path.join(__dirname, '..');
const { check, report } = makeChecker();
const { computeCycleSnapshot } = require(path.join(ROOT, 'cycleSnapshot.js'));

/* ------------------------------------------------------------------ data */
const row = (cycleId, week, name, weight, reps) => reps.map(r => ({
    workout_id: cycleId * 1000 + week, finished_at: `2026-06-${String(week).padStart(2, '0')}T10:00:00Z`,
    cycle_id: cycleId, week_number: week, exercise_name: name, weight_value: weight, weight_unit: 'lb',
    is_bodyweight: weight === null, reps_value: r, swapped_from: null
}));

const PROGRAM = {
    days: [{ exercises: [
        { name: 'Cat-Cow', role: 'warmup', repRange: '10' },
        { name: 'Bench Press', role: 'main', repRange: '6-8' },
        { name: 'Pull Ups', role: 'main', repRange: '6-10' }] }],
    weeks: []
};

function build(total, logged, name = 'Bench Press') {
    const rows = [];
    for (let w = 1; w <= logged; w++) {
        const deload = w === total;
        rows.push(...row(1, w, 'Cat-Cow', null, [10]));
        rows.push(...row(1, w, name, deload ? 115 : 135 + w * 5, deload ? [6, 6] : [8, 7, 6]));
        rows.push(...row(1, w, 'Pull Ups', null, [6 + w, 6, 5]));
    }
    const cycle = { id: 1, name: 'Test', total_weeks: total, program: PROGRAM };
    return computeCycleSnapshot(rows, cycle, {});
}
const wrap = cycle => ({ cycle, counts: { allTime: 12 }, totalSets: 40 });

/* --------------------------------------------------------------- harness */
function harness(fetchImpl) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const inline = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
        .sort((a, b) => b.length - a.length)[0].replace(/^<script>/, '').replace(/<\/script>$/, '');

    const els = {};
    const el = id => els[id] || (els[id] = {
        innerHTML: '', innerText: '', textContent: '', value: '', className: '', dataset: {},
        classList: { add() {}, remove() {}, contains: () => false }, querySelector: () => null, scrollIntoView() {}
    });
    const ctx = {
        console, Date, JSON, Math, parseInt, Array, Object, String, Number, Set, Map, Promise,
        setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
        navigator: {}, window: { addEventListener() {} }, self: {}, alert: () => {}, confirm: () => true,
        fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({}) })),
        localStorage: { getItem: () => 'token', setItem() {}, removeItem() {} },
        document: { addEventListener() {}, getElementById: el, querySelector: () => null, querySelectorAll: () => [] }
    };
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(inline, ctx);
    return { ctx, body: () => el('metrics-body').innerHTML };
}

const count = (s, needle) => s.split(needle).length - 1;

(async () => {
    const { ctx } = harness();
    const html = (data, ui) => ctx.metricsHtml(data, Object.assign({ openLift: null, groupOpen: false }, ui || {}));

    console.log('\n=== empty states ===\n');
    check('no cycle says so', /No active cycle/.test(html(wrap(null))), true);
    check('no data at all does not throw', /No active cycle/.test(html(null)), true);
    check('a cycle with nothing logged says so', /Nothing logged yet/.test(html(wrap(computeCycleSnapshot([], { id: 1, total_weeks: 6 })))), true);
    const week1 = html(wrap(build(6, 1)));
    check('one week logged: no headline yet', /Not yet/.test(week1), true);
    check('and asks for a second week', /second week of training/.test(week1), true);
    check('but the grid is still there', count(week1, 'class="ms-row"'), 2);

    console.log('\n=== the panel and the grid ===\n');
    const s6 = build(6, 5);
    const h6 = html(wrap(s6));
    check('headline number is drawn', h6.includes(`>${ctx.msHero(s6.summary.strengthPct)}</b>`), true);
    check('week position is shown', /Week 5 of 6/.test(h6), true);
    check('a trajectory chart is drawn', /<svg[^>]*aria-label="Average strength gain by week/.test(h6), true);
    check('the split between weight and reps is shown', /Heavier weight/.test(h6) && /More reps/.test(h6), true);
    check('progress lifts get rows; the warm-up does not', count(h6, 'class="ms-row"'), 2);
    check('the grid has one column per week', h6.includes('--n:6'), true);
    check('the whole-cycle total line is shown', /12 workouts and 40 sets/.test(h6), true);

    console.log('\n=== any cycle length ===\n');
    for (const n of [4, 6, 8, 12, 16]) {
        const out = html(wrap(build(n, n - 1)));
        check(`${n} weeks: one column per week`, out.includes(`--n:${n}`), true);
        check(`${n} weeks: dense layout only when crowded`, out.includes('ms-dense'), n > 8);
        check(`${n} weeks: labels only while there is room`, out.includes('<small>+') || out.includes('<small>-'), n <= 8);
        check(`${n} weeks: a phase band is drawn`, /ms-p-base/.test(out), true);
    }

    console.log('\n=== deload weeks ===\n');
    const dl = html(wrap(build(6, 6)));
    check('a logged deload is flagged in the grid', /class="ms-cell ms-deload"/.test(dl), true);
    check('and in the chart', /DELOAD/.test(dl), true);
    check('and explained in the legend', /Deload week · lighter on purpose/.test(dl), true);
    check('the phase band marks it', /ms-p-deload/.test(dl), true);
    check('a lighter deload week is never labelled "slipped"', dl.includes('Week 6: Slipped'), false);
    check('it is labelled as a deload instead', dl.includes('Week 6: deload week'), true);
    const upcoming = html(wrap(build(6, 5)));
    check('an unlogged deload has no amber point or legend', /Deload week · lighter on purpose/.test(upcoming), false);
    check('but the upcoming deload is still marked on the chart', /DELOAD/.test(upcoming), true);

    console.log('\n=== warm-ups ===\n');
    check('collapsed: shown as a group', /Warm-up/.test(h6) && /not tracked for progress/.test(h6), true);
    check('collapsed: shows completion', /5 of 5/.test(h6), true);
    check('collapsed: the movement itself is hidden', h6.includes('Cat-Cow'), false);
    const open = html(wrap(s6), { groupOpen: true });
    check('expanded: lists the movement', open.includes('Cat-Cow'), true);
    check('expanded: with a check for each week done', count(open, '>✓<'), 5);
    check('expanded: and says why it is not tracked', /ms-tag ms-shade">Warm-up</.test(open), true);
    check('a warm-up never gets a stalling flag', /Stalling/.test(open.split('ms-group')[1] || ''), false);

    const off = computeCycleSnapshot(
        [...row(1, 1, 'Bench Press', 135, [8]), ...row(1, 2, 'Bench Press', 135, [8])],
        { id: 1, total_weeks: 6, program: null, tracking_overrides: { 'bench press': 'consistency' } });
    const offHtml = html(wrap(off), { groupOpen: true });
    check('a lift the lifter turned off lands in the group', /Turned off by you/.test(offHtml), true);
    check('and the group is titled for what it is', /ms-name">Not tracked</.test(offHtml), true);

    console.log('\n=== opening a lift ===\n');
    const idx = s6.movements.findIndex(m => m.name === 'Bench Press');
    const closed = html(wrap(s6)), openLift = html(wrap(s6), { openLift: idx });
    check('closed: no set detail', closed.includes('ms-detail'), false);
    check('open: shows the sets', /135 lb|140 lb/.test(openLift) && openLift.includes('ms-detail'), true);
    check('open: shows the target range', /Target range 6–8 reps/.test(openLift), true);
    check('rows are real buttons', /role="button" tabindex="0" aria-expanded="true"/.test(openLift), true);

    console.log('\n=== untrusted text ===\n');
    const evil = '<img src=x onerror=alert(1)>';
    const evilHtml = html(wrap(build(6, 5, evil)), { openLift: 0, groupOpen: true });
    check('a hostile movement name is escaped, never injected', evilHtml.includes('<img src=x'), false);
    check('it is shown as text instead', evilHtml.includes('&lt;img src=x onerror=alert(1)&gt;'), true);

    console.log('\n=== the loading flow ===\n');
    const data = wrap(s6);
    const calls = [];
    let h = harness(async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => data }; });
    await h.ctx.loadMetrics();
    check('loading renders the scorecard into the page', /Cycle strength/.test(h.body()), true);
    check('it asks the metrics endpoint', calls[0].url, '/api/metrics');
    check('with the user\'s token', calls[0].opts.headers.Authorization, 'Bearer token');

    h = harness(async () => ({ ok: false, json: async () => ({}) }));
    await h.ctx.loadMetrics();
    check('a failed request shows an error and a retry', /Could not load your metrics/.test(h.body()) && /Retry/.test(h.body()), true);

    h = harness(async () => ({ ok: true, json: async () => data }));
    await h.ctx.loadMetrics();
    h.ctx.toggleMetricsLift(idx);
    check('tapping a lift opens it', h.body().includes('ms-detail'), true);
    h.ctx.toggleMetricsLift(idx);
    check('tapping again closes it', h.body().includes('ms-detail'), false);
    h.ctx.toggleMetricsGroup();
    check('tapping the warm-up group opens it', h.body().includes('Cat-Cow'), true);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
