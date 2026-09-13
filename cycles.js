// Periodisation: which phase a given week of a cycle belongs to, and what that means for
// the prompt.
//
// The old app hardcoded a 4-week Base/Build/Peak/Deload timeline that was pure decoration —
// every prompt asked for `"week": 1` and nothing ever advanced. Cycle length is now the
// user's choice, so phases have to scale to an arbitrary N rather than being four fixed labels.
//
// This lives server-side and the phase list is handed to the client with the cycle, so the
// timeline and the prompts can never disagree about what week 4 of 7 is.

const PHASES = {
    base:   { label: 'Base',   blurb: 'Accumulation. Build work capacity and movement quality. Moderate loads, higher volume, leave 2-3 reps in reserve.' },
    build:  { label: 'Build',  blurb: 'Intensification. Add load while holding volume roughly steady. Push closer to 1-2 reps in reserve on main lifts.' },
    peak:   { label: 'Peak',   blurb: 'Peaking. Heaviest loads of the cycle on main lifts, with accessory volume cut back to manage fatigue.' },
    deload: { label: 'Deload', blurb: 'Recovery. Cut volume by roughly half and keep loads light to moderate. The point is to arrive fresh, not to train hard.' }
};

/**
 * Which phase week `week` of a `totalWeeks` cycle falls in.
 *
 * Short cycles cannot afford a deload week and should not waste one — a 2-week block that
 * spends half itself deloading trains almost nothing. From 4 weeks up the final week is a
 * deload and the remainder is split roughly 40/35/25 across base, build and peak.
 *
 * The split is computed as WEEK COUNTS rather than by comparing each week's position against
 * fraction thresholds. Thresholds looked equivalent and were not: they gave a 4-week cycle
 * base/base/build/deload, with no peak week at all, and an 8-week cycle only one. Every phase
 * gets at least one week whenever there are enough weeks to go round.
 */
function phaseCounts(workingWeeks) {
    const w = workingWeeks;
    if (w <= 0) return { base: 0, build: 0, peak: 0 };
    if (w === 1) return { base: 0, build: 1, peak: 0 };
    if (w === 2) return { base: 1, build: 1, peak: 0 };

    const base = Math.max(1, Math.round(w * 0.4));
    const peak = Math.max(1, Math.round(w * 0.25));
    let build = w - base - peak;

    // Rounding can squeeze build to nothing on some lengths; take the week back from base,
    // which is the phase that can most afford it.
    if (build < 1) return { base: Math.max(1, w - 2), build: 1, peak: 1 };

    return { base, build, peak };
}

function phaseForWeek(week, totalWeeks) {
    const n = Math.max(1, Number(totalWeeks) || 1);
    const w = Math.min(Math.max(1, Number(week) || 1), n);

    if (n === 1) return 'build';
    if (n === 2) return w === 1 ? 'build' : 'peak';
    if (n === 3) return ['base', 'build', 'peak'][w - 1];

    if (w === n) return 'deload';

    const { base, build } = phaseCounts(n - 1);
    if (w <= base) return 'base';
    if (w <= base + build) return 'build';
    return 'peak';
}

/** Phase for every week, for rendering the timeline. */
function phasesForCycle(totalWeeks) {
    const n = Math.max(1, Number(totalWeeks) || 1);
    const out = [];
    for (let w = 1; w <= n; w++) {
        const key = phaseForWeek(w, n);
        out.push({ week: w, phase: key, label: PHASES[key].label });
    }
    return out;
}

/** The instruction block injected into the plan prompt for this week. */
function phaseGuidance(week, totalWeeks) {
    const key = phaseForWeek(week, totalWeeks);
    const p = PHASES[key];
    return `This is week ${week} of a ${totalWeeks}-week cycle. Phase: ${p.label}.\n${p.blurb}`;
}

const MIN_WEEKS = 2;
const MAX_WEEKS = 16;

function clampWeeks(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return 6;
    return Math.min(MAX_WEEKS, Math.max(MIN_WEEKS, v));
}

const RECOMMENDATION_SCHEMA = {
    type: 'object',
    properties: {
        weeks: { type: 'integer' },
        rationale: { type: 'string' }
    },
    required: ['weeks', 'rationale']
};

function validateRecommendation(r) {
    if (!r || typeof r !== 'object') return 'not an object';
    if (!Number.isFinite(Number(r.weeks))) return 'weeks is not a number';
    if (Number(r.weeks) < MIN_WEEKS || Number(r.weeks) > MAX_WEEKS) {
        return `weeks ${r.weeks} outside ${MIN_WEEKS}-${MAX_WEEKS}`;
    }
    if (typeof r.rationale !== 'string' || r.rationale.trim() === '') return 'missing rationale';
    return null;
}

module.exports = {
    PHASES, phaseForWeek, phasesForCycle, phaseGuidance,
    clampWeeks, MIN_WEEKS, MAX_WEEKS,
    RECOMMENDATION_SCHEMA, validateRecommendation
};
