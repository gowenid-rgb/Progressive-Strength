/*
 * T3-10 — training aggregates.
 *
 * computeMetrics is a pure function over rows with an injected clock, so period boundaries
 * and unit handling are tested directly rather than by seeding a database and hoping the
 * calendar cooperates.
 */
process.env.JWT_SECRET = 'metrics-test-secret-long-enough-to-avoid-warnings';
process.env.DATABASE_URL = 'postgres://test/test';
process.env.AI_BURST_MAX = '100';
process.env.AUTH_MAX = '100';

const path = require('path');
const http = require('http');
const { installPgShim, makeChecker } = require('./helpers/pgshim');

const ROOT = path.join(__dirname, '..');
const { check, report } = makeChecker();

let PORT = null;
function req(method, p, body, token) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { 'Content-Type': 'application/json' };
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
        if (token) headers.Authorization = 'Bearer ' + token;
        const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, res => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => {
                let parsed; try { parsed = JSON.parse(d); } catch (e) { parsed = d; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
    });
}

// Wednesday 2026-09-16, midday. Mid-week, mid-month, mid-year, so every boundary is visible.
const NOW = new Date('2026-09-16T12:00:00Z');

function set(workoutId, dateISO, name, weight, reps, extra) {
    return Object.assign({
        workout_id: workoutId,
        finished_at: dateISO,
        exercise_name: name,
        weight_value: weight,
        weight_unit: 'lb',
        is_bodyweight: false,
        reps_value: reps,
        swapped_from: null
    }, extra || {});
}

(async () => {
    const pg = installPgShim();
    const { computeMetrics, canonicalName, startOfWeek } = require(path.join(ROOT, 'metrics.js'));

    console.log('\n=== T3-10: empty and degenerate input ===\n');

    const empty = computeMetrics([], NOW);
    check('no rows gives zero workouts', empty.counts.allTime, 0);
    check('no rows gives zero volume', empty.volume.allTime, 0);
    check('no rows has no movements', empty.movements, []);
    check('no rows has nothing trendable', empty.trendable, []);
    check('null input does not throw', computeMetrics(null, NOW).counts.allTime, 0);

    console.log('\n=== T3-10: volume ===\n');

    let m = computeMetrics([
        set(1, '2026-09-16T10:00:00Z', 'Bench Press', 100, 5),
        set(1, '2026-09-16T10:05:00Z', 'Bench Press', 100, 5)
    ], NOW);
    check('volume is weight times reps, summed', m.volume.allTime, 1000);
    check('sets counted', m.totalSets, 2);
    check('one session, not two', m.counts.allTime, 1);

    // kg must be converted, or a kg lifter's totals are silently 2.2x too small.
    m = computeMetrics([
        set(1, '2026-09-16T10:00:00Z', 'Squat', 100, 1, { weight_unit: 'kg' })
    ], NOW);
    check('kg converts to pounds', m.volume.allTime, 220);

    // Bodyweight contributes no volume but still counts as work done.
    m = computeMetrics([
        set(1, '2026-09-16T10:00:00Z', 'Pull Ups', null, 10, { is_bodyweight: true }),
        set(1, '2026-09-16T10:05:00Z', 'Bench Press', 100, 5)
    ], NOW);
    check('bodyweight adds no volume', m.volume.allTime, 500);
    check('bodyweight still counts as a set', m.totalSets, 2);
    check('bodyweight movement still listed', m.movements.some(x => x.name === 'Pull Ups'), true);
    check('bodyweight movement has no best set', m.movements.find(x => x.name === 'Pull Ups').best, null);

    // Unparseable weight (weight_raw kept, weight_value null) must not poison the totals.
    m = computeMetrics([
        set(1, '2026-09-16T10:00:00Z', 'Squat', null, 5),
        set(1, '2026-09-16T10:05:00Z', 'Squat', 200, 5)
    ], NOW);
    check('unparseable set contributes nothing', m.volume.allTime, 1000);
    check('unparseable set still counted as a set', m.totalSets, 2);

    console.log('\n=== T3-10: period boundaries ===\n');

    const rows = [
        set(1, '2026-09-16T10:00:00Z', 'Squat', 100, 1),   // today
        set(2, '2026-09-14T10:00:00Z', 'Squat', 100, 1),   // Monday, this week
        set(3, '2026-09-13T10:00:00Z', 'Squat', 100, 1),   // Sunday, LAST week
        set(4, '2026-09-02T10:00:00Z', 'Squat', 100, 1),   // earlier this month
        set(5, '2026-08-20T10:00:00Z', 'Squat', 100, 1),   // this year
        set(6, '2025-11-01T10:00:00Z', 'Squat', 100, 1)    // last year
    ];
    m = computeMetrics(rows, NOW);
    check('this week counts Monday onward', m.counts.week, 2);
    check('Sunday belongs to the previous week', m.counts.week !== 3, true);
    check('this month', m.counts.month, 4);
    check('this year', m.counts.year, 5);
    check('all time', m.counts.allTime, 6);
    check('volume follows the same buckets', m.volume.week, 200);

    const ws = startOfWeek(NOW);
    check('week starts on Monday', ws.getDay(), 1);
    // A Monday reference date must not roll back a whole week.
    check('Monday is its own week start', startOfWeek(new Date('2026-09-14T09:00:00Z')).getDate(), 14);

    console.log('\n=== T3-10: progression ===\n');

    m = computeMetrics([
        set(1, '2026-09-01T10:00:00Z', 'Bench Press', 135, 5),
        set(1, '2026-09-01T10:05:00Z', 'Bench Press', 155, 3),   // heaviest of session 1
        set(2, '2026-09-08T10:00:00Z', 'Bench Press', 165, 3),   // heaviest of session 2
        set(2, '2026-09-08T10:05:00Z', 'Bench Press', 145, 5),
        set(3, '2026-09-15T10:00:00Z', 'Bench Press', 175, 2)
    ], NOW);
    const bench = m.movements.find(x => x.name === 'Bench Press');
    check('one point per session, not per set', bench.points.length, 3);
    check('point is the heaviest set of that session', bench.points[0].weight, 155);
    check('points are chronological', bench.points.map(p => p.weight), [155, 165, 175]);
    check('best set is the heaviest overall', bench.best.weight, 175);
    check('best set carries its reps', bench.best.reps, 2);
    check('sessions counted, not sets', bench.sessions, 3);
    check('movement is trendable', m.trendable.includes('Bench Press'), true);

    // Equal weight, more reps is the better set.
    m = computeMetrics([
        set(1, '2026-09-01T10:00:00Z', 'Squat', 200, 3),
        set(1, '2026-09-01T10:05:00Z', 'Squat', 200, 5)
    ], NOW);
    check('ties break on reps', m.movements[0].best.reps, 5);

    // One session is a point, not a line.
    m = computeMetrics([set(1, '2026-09-01T10:00:00Z', 'Deadlift', 300, 3)], NOW);
    check('single session is not trendable', m.trendable, []);
    check('single session still has a best set', m.movements[0].best.weight, 300);

    // Most-trained movement first, so the default chart is the one worth looking at.
    m = computeMetrics([
        set(1, '2026-09-01T10:00:00Z', 'Curl', 30, 10),
        set(2, '2026-09-02T10:00:00Z', 'Squat', 200, 5),
        set(3, '2026-09-03T10:00:00Z', 'Squat', 205, 5),
        set(4, '2026-09-04T10:00:00Z', 'Squat', 210, 5)
    ], NOW);
    check('movements ordered by sessions', m.movements[0].name, 'Squat');
    check('trendable ordered the same way', m.trendable[0], 'Squat');

    console.log('\n=== name drift between weeks ===\n');

    // The bug that made progression look broken: a model names the same lift differently each
    // week, so one climbing movement becomes several one-session movements and nothing charts.
    m = computeMetrics([
        set(1, '2026-09-08T10:00:00Z', 'Barbell Bench Press', 135, 5),
        set(2, '2026-09-15T10:00:00Z', 'Bench Press (Barbell)', 145, 5)
    ], NOW);
    check('reordered name groups as one movement', m.movements.length, 1);
    check('it becomes trendable', m.trendable.length, 1);
    check('both sessions land on one line', m.movements[0].points.map(p => p.weight), [135, 145]);
    check('displayed under the most recent spelling', m.movements[0].name, 'Bench Press (Barbell)');
    check('the older spelling is surfaced, not hidden', m.movements[0].aliases, ['Barbell Bench Press']);

    check('punctuation ignored', canonicalName('Bench Press (Barbell)'), canonicalName('Barbell Bench Press'));
    check('casing ignored', canonicalName('BARBELL ROW'), canonicalName('barbell row'));
    check('hyphenation ignored', canonicalName('Chin-Ups'), canonicalName('Chin Ups'));

    // Equipment must keep movements apart. Merging these would chart 185 next to 60 and call
    // it a collapse -- over-merging invents data, under-merging only shows less.
    check('barbell and dumbbell stay separate',
        canonicalName('Barbell Bench Press') === canonicalName('Dumbbell Bench Press'), false);
    check('machine and cable stay separate',
        canonicalName('Machine Row') === canonicalName('Cable Row'), false);

    m = computeMetrics([
        set(1, '2026-09-08T10:00:00Z', 'Barbell Bench Press', 185, 3),
        set(2, '2026-09-15T10:00:00Z', 'Dumbbell Bench Press', 60, 10)
    ], NOW);
    check('equipment variants remain two movements', m.movements.length, 2);
    check('neither becomes a false trend', m.trendable, []);

    check('empty name does not throw', canonicalName(''), '');
    check('null name does not throw', canonicalName(null), '');

    console.log('\n=== T3-10: the endpoint ===\n');

    const realListen = http.Server.prototype.listen;
    await new Promise(resolve => {
        http.Server.prototype.listen = function (...args) {
            const cb = args[args.length - 1];
            return realListen.call(this, 0, () => {
                PORT = this.address().port;
                if (typeof cb === 'function') cb();
                resolve();
            });
        };
        require(path.join(ROOT, 'server.js'));
    });
    http.Server.prototype.listen = realListen;

    const db = require(path.join(ROOT, 'db.js'));
    await require(path.join(ROOT, 'migrate.js')).migrate(db);

    const anon = await req('GET', '/api/metrics');
    check('metrics requires auth', anon.status, 401);

    const reg = await req('POST', '/api/auth/register', { email: 'metrics@example.com', password: 'password1234' });
    const token = reg.body.token;

    let r = await req('GET', '/api/metrics', undefined, token);
    check('new user gets an empty summary, not an error', r.status, 200);
    check('new user has no workouts', r.body.counts.allTime, 0);

    await req('POST', '/api/user/data', {
        currentPlan: { planName: 'P', days: [{ dayName: 'A', exercises: [{ name: 'Bench Press', sets: 3, reps: '5' }] }] },
        cycleOptions: { totalWeeks: 6 }
    }, token);

    await req('POST', '/api/workouts', {
        dayName: 'Push', durationSeconds: 3600,
        exercises: [{ name: 'Bench Press', sets: [
            { set: 1, weight: '135', reps: '5' },
            { set: 2, weight: '155', reps: '3' }
        ] }]
    }, token);
    await req('POST', '/api/workouts', {
        dayName: 'Push', durationSeconds: 3600,
        exercises: [
            { name: 'Bench Press', sets: [{ set: 1, weight: '165', reps: '3' }] },
            { name: 'Pull Ups', sets: [{ set: 1, weight: 'BW', reps: '8' }] }
        ]
    }, token);

    r = await req('GET', '/api/metrics', undefined, token);
    check('both workouts counted', r.body.counts.allTime, 2);
    check('sets counted across workouts', r.body.totalSets, 4);
    check('volume computed from real rows', r.body.volume.allTime, 135 * 5 + 155 * 3 + 165 * 3);
    check('bench is trendable after two sessions', r.body.trendable.includes('Bench Press'), true);
    check('bodyweight movement present but not trendable', r.body.trendable.includes('Pull Ups'), false);

    const benchLive = r.body.movements.find(x => x.name === 'Bench Press');
    check('progression has one point per session', benchLive.points.length, 2);
    check('first point is the heaviest of session one', benchLive.points[0].weight, 155);
    check('best set across sessions', benchLive.best.weight, 165);

    // Isolation: metrics must never leak between accounts.
    const other = await req('POST', '/api/auth/register', { email: 'other-metrics@example.com', password: 'password1234' });
    const otherMetrics = await req('GET', '/api/metrics', undefined, other.body.token);
    check('a second user sees none of it', otherMetrics.body.counts.allTime, 0);

    report();
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
