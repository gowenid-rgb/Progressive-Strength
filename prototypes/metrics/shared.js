// PROTOTYPE DATA + HELPERS — not wired to the app. A believable 6-week double-progression
// cycle, hand-written so each lift tells a different story:
//   Bench        load jump in W4: reps reset, tonnage DROPS even though it got stronger
//   Squat        textbook double progression
//   Incline DB   35 lb for four weeks, climbing the 12–15 range, then up to 40
//   Cable Row    reps cut when the load went up, then recovering
//   Overhead     genuinely stalled
//   RDL          load up every other week
(function () {
    const S = (w, reps) => reps.map(r => [w, r]);

    const CYCLE = {
        name: 'Upper / Lower Hypertrophy',
        totalWeeks: 6,
        currentWeek: 5,                       // weeks 1–5 are logged, 6 is the deload
        phases: ['Accumulate', 'Accumulate', 'Intensify', 'Intensify', 'Peak', 'Deload'],
        movements: [
            { name: 'Barbell Bench Press', short: 'Bench', range: [6, 8], weeks: [
                S(135, [8, 7, 6, 6]), S(135, [8, 8, 7, 6]), S(135, [8, 8, 8, 8]),
                S(140, [7, 6, 6, 6]), S(140, [8, 7, 7, 6])] },
            { name: 'Back Squat', short: 'Squat', range: [5, 8], weeks: [
                S(185, [8, 7, 6, 6]), S(185, [8, 8, 7, 7]), S(185, [8, 8, 8, 8]),
                S(195, [7, 6, 6, 5]), S(195, [7, 7, 6, 6])] },
            { name: 'Incline Dumbbell Press', short: 'Incline DB', range: [12, 15], weeks: [
                S(35, [13, 12, 12]), S(35, [14, 13, 12]), S(35, [15, 14, 13]),
                S(35, [15, 15, 15]), S(40, [12, 12, 11])] },
            { name: 'Seated Cable Row', short: 'Cable Row', range: [10, 12], weeks: [
                S(100, [12, 11, 10]), S(100, [12, 12, 12]), S(110, [10, 10, 9]),
                S(110, [11, 10, 10]), S(110, [12, 12, 12])] },
            { name: 'Overhead Press', short: 'OHP', range: [8, 10], weeks: [
                S(85, [9, 8, 8]), S(85, [9, 8, 8]), S(85, [8, 8, 7]),
                S(85, [9, 8, 8]), S(85, [8, 8, 7])] },
            { name: 'Romanian Deadlift', short: 'RDL', range: [8, 10], weeks: [
                S(135, [10, 10, 10]), S(145, [9, 8, 8]), S(145, [10, 9, 9]),
                S(155, [9, 8, 8]), S(155, [10, 9, 9])] }
        ]
    };

    const KIND = {
        load:     { label: 'More weight', glyph: '▲', color: 'var(--load)' },
        reps:     { label: 'More reps',   glyph: '+', color: 'var(--reps)' },
        hold:     { label: 'Held',        glyph: '=', color: 'var(--hold)' },
        down:     { label: 'Slipped',     glyph: '▼', color: 'var(--down)' },
        start:    { label: 'Baseline',    glyph: '●', color: 'var(--hold)' },
        upcoming: { label: 'Upcoming',    glyph: '',  color: 'var(--hold)' }
    };

    function stats(m, i) {
        const s = m.weeks[i];
        if (!s) return null;
        return {
            sets: s.length,
            reps: s.reduce((a, x) => a + x[1], 0),
            tonnage: s.reduce((a, x) => a + x[0] * x[1], 0),
            top: Math.max(...s.map(x => x[0])),
            e1rm: Math.max(...s.map(x => x[0] * (1 + x[1] / 30)))   // Epley, best set
        };
    }

    // What kind of progress happened this week vs last. Order matters: any extra weight on
    // any set counts first, then more total reps, because both are real progress and the
    // old "heaviest set" chart could only ever see the first.
    function delta(m, i) {
        if (i === 0) return { kind: 'start', text: 'Baseline' };
        const a = stats(m, i - 1), b = stats(m, i);
        if (!b) return { kind: 'upcoming', text: '' };
        if (b.top > a.top) return { kind: 'load', n: b.top - a.top, text: '+' + (b.top - a.top) + ' lb' };
        if (b.top < a.top) return { kind: 'down', n: b.top - a.top, text: (b.top - a.top) + ' lb' };
        if (b.reps > a.reps) return { kind: 'reps', n: b.reps - a.reps, text: '+' + (b.reps - a.reps) + (b.reps - a.reps === 1 ? ' rep' : ' reps') };
        if (b.reps === a.reps) return { kind: 'hold', n: 0, text: 'Same' };
        return { kind: 'down', n: b.reps - a.reps, text: (b.reps - a.reps) + ' reps' };
    }

    const loggedWeeks = () => Array.from({ length: CYCLE.currentWeek }, (_, i) => i);
    const pct = (a, b) => (a ? (b / a - 1) * 100 : 0);
    const fmt = n => Math.round(n).toLocaleString();
    const sign = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
    const signPct = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(0) + '%';

    // "Ready to add weight": every set at the top of the range. This is the double
    // progression trigger the user described.
    function readyForMore(m, i) {
        const s = m.weeks[i];
        return !!s && s.every(x => x[1] >= m.range[1]);
    }

    // Stalling = at most one of the last three weeks moved forward.
    function stalling(m) {
        const last = CYCLE.currentWeek - 1;
        let moved = 0;
        for (let i = last - 2; i <= last; i++) {
            const k = delta(m, i).kind;
            if (k === 'load' || k === 'reps') moved++;
        }
        return moved <= 1;
    }

    window.PS = { CYCLE, KIND, stats, delta, loggedWeeks, pct, fmt, sign, signPct, readyForMore, stalling };

    // Phone frame header shared by every concept.
    window.PS.frame = function (concept, title, blurb) {
        document.body.insertAdjacentHTML('afterbegin', `
          <div class="proto-bar"><a href="index.html">← All concepts</a><span>${concept}</span></div>
          <div class="phone"><div class="phone-head">
            <div class="eyebrow">${CYCLE.name}</div>
            <h1>${title}</h1><p class="blurb">${blurb}</p></div><div id="app"></div></div>`);
    };
})();
