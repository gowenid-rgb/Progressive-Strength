// Safety rails around "Adjust program".
//
// The model rewrites the current week's plan from a sentence of feedback. Whatever it returns
// is only ever a PLAN: logged sessions live in their own append-only tables and are never read
// back from it. These helpers make sure the plan it returns cannot quietly do harm anyway:
//   - names are snapped back to the spelling already in use, so a re-worded lift ("Deadlift"
//     for "Barbell Deadlift") does not split its history in two;
//   - days already completed are restored exactly as they were;
//   - warm-ups stay a single set;
//   - a "from now on" set-count change is written into the cycle's programme, which is what
//     every later week is built from.
const { canonicalName } = require('./metrics');
const { normaliseRole } = require('./program');

// Words that name the implement. They are not noise (a dumbbell press is a different lift from
// a barbell press), but a name that differs from a known one ONLY by gaining or losing one of
// these is almost certainly the model re-wording the same lift.
const EQUIPMENT = new Set(['barbell', 'dumbbell', 'dumbbells', 'cable', 'machine', 'smith', 'ez', 'bar',
    'kettlebell', 'band', 'bodyweight']);

function words(name) {
    return canonicalName(name).split(' ').filter(Boolean);
}

/**
 * The anchored spelling for `name`, or null when it is a genuinely new movement.
 * Exact (case-insensitive) matches win; then same words in another order or punctuation; then
 * the same words plus or minus an implement word. Anything ambiguous is left alone.
 */
function anchorFor(name, anchors, feedback) {
    const lower = String(name || '').trim().toLowerCase();
    if (!lower) return null;
    if (anchors.some(a => a.toLowerCase() === lower)) return null; // already exact

    const mine = words(name);
    if (mine.length === 0) return null;
    const mineKey = mine.join(' ');

    const sameWords = anchors.filter(a => words(a).join(' ') === mineKey);
    if (sameWords.length === 1) return sameWords[0];
    if (sameWords.length > 1) return null;

    const mineSet = new Set(mine);
    const near = anchors.filter(a => {
        const theirs = words(a);
        if (theirs.length === 0) return false;
        const theirSet = new Set(theirs);
        const onlyMine = mine.filter(w => !theirSet.has(w));
        const onlyTheirs = theirs.filter(w => !mineSet.has(w));
        // One side must be a strict subset of the other, and the extra words must all be
        // implement words. A swap of one implement for another ("Barbell" for "Dumbbell")
        // has words on both sides, so it is a different lift and is left alone.
        const oneWay = (onlyMine.length === 0) !== (onlyTheirs.length === 0);
        const extras = onlyMine.length ? onlyMine : onlyTheirs;
        // If the lifter themselves mentioned that implement ("use dumbbells"), the change of
        // name is deliberate and must stand.
        const asked = extras.some(w => String(feedback || '').toLowerCase().includes(w.replace(/s$/, '')));
        return oneWay && !asked && extras.every(w => EQUIPMENT.has(w));
    });
    return near.length === 1 ? near[0] : null;
}

/**
 * Rewrites movement names in `plan` onto the spelling in `anchors` (`feedback` is the lifter's
 * request, used to leave deliberate renames alone). Mutates and returns
 * { plan, renamed: [{ from, to }] }.
 */
function snapNames(plan, anchors, feedback) {
    const renamed = [];
    const list = Array.from(new Set((anchors || []).map(a => String(a || '').trim()).filter(Boolean)));
    (plan && Array.isArray(plan.days) ? plan.days : []).forEach(day => {
        const used = new Set();
        (day && Array.isArray(day.exercises) ? day.exercises : []).forEach(ex => {
            if (!ex || typeof ex.name !== 'string') return;
            const target = anchorFor(ex.name, list, feedback);
            if (target && !used.has(target.toLowerCase())) {
                renamed.push({ from: ex.name, to: target });
                ex.name = target;
            }
            used.add(ex.name.trim().toLowerCase());
        });
    });
    return { plan, renamed };
}

/**
 * Days already done are history, not plan. Puts the originals back at their positions
 * whatever the model did to them, and keeps any day it added or removed after them.
 */
function restoreCompletedDays(newPlan, oldPlan) {
    const oldDays = oldPlan && Array.isArray(oldPlan.days) ? oldPlan.days : [];
    const newDays = newPlan && Array.isArray(newPlan.days) ? newPlan.days : [];
    const sameDay = (a, b) => String(a && a.dayName || '').trim().toLowerCase() === String(b && b.dayName || '').trim().toLowerCase();

    const out = [];
    let j = 0;
    oldDays.forEach(day => {
        if (day && day.completed) {
            out.push(JSON.parse(JSON.stringify(day)));
            // The model's version of this day (same name) is discarded; if it left the day out,
            // nothing is consumed and its other days keep their place.
            if (newDays[j] && sameDay(newDays[j], day)) j++;
        } else if (newDays[j]) {
            out.push(newDays[j++]);
        }
    });
    while (j < newDays.length) out.push(newDays[j++]); // days the model added
    newPlan.days = out;
    return newPlan;
}

function roleLookup(prog) {
    const byDay = [];
    ((prog && Array.isArray(prog.days)) ? prog.days : []).forEach((d, i) => {
        const m = new Map();
        (Array.isArray(d.exercises) ? d.exercises : []).forEach(e => {
            if (e && e.name) m.set(canonicalName(e.name), e);
        });
        byDay[i] = m;
    });
    return byDay;
}

/** Warm-ups are always a single set, whatever the model wrote. */
function lockWarmups(plan, prog) {
    const roles = roleLookup(prog);
    (plan && Array.isArray(plan.days) ? plan.days : []).forEach((day, i) => {
        if (day && day.completed) return;
        (Array.isArray(day.exercises) ? day.exercises : []).forEach(ex => {
            const known = roles[i] && roles[i].get(canonicalName(ex.name));
            const role = known ? normaliseRole(known.role) : null;
            if (role === 'warmup') ex.sets = 1;
        });
    });
    return plan;
}

/**
 * Set counts that differ between two versions of the plan, on days not yet completed.
 * [{ dayIndex, name, from, to }]
 */
function diffSets(oldPlan, newPlan) {
    const out = [];
    const oldDays = oldPlan && Array.isArray(oldPlan.days) ? oldPlan.days : [];
    (newPlan && Array.isArray(newPlan.days) ? newPlan.days : []).forEach((day, i) => {
        const before = oldDays[i];
        if (!before || before.completed || (day && day.completed)) return;
        const prior = new Map();
        (Array.isArray(before.exercises) ? before.exercises : []).forEach(e => {
            if (e && e.name) prior.set(String(e.name).trim().toLowerCase(), Number(e.sets));
        });
        (Array.isArray(day.exercises) ? day.exercises : []).forEach(e => {
            const key = String(e.name || '').trim().toLowerCase();
            const from = prior.get(key);
            const to = Number(e.sets);
            if (from !== undefined && Number.isFinite(from) && Number.isFinite(to) && to >= 1 && from !== to) {
                out.push({ dayIndex: i, name: e.name, from, to });
            }
        });
    });
    return out;
}

// The lifter has to say it lasts. A one-off tweak to this week's volume should not rewrite the
// rest of the cycle.
const FUTURE_RE = /\b(future|going forward|from now on|moving forward|rest of (the|this) (cycle|program|programme|block)|all (the )?(remaining|later|upcoming|next)|every (week|workout|session)|all (workouts|weeks|sessions)|each (week|workout|session)|next weeks?|permanent(ly)?)\b/i;

function wantsFuture(feedback) {
    return FUTURE_RE.test(String(feedback || ''));
}

/**
 * Writes set-count changes into the programme (baseSets), which every later week is rendered
 * from. Returns { program, applied } and never touches the programme's movements or history.
 */
function applySetChangesToProgram(prog, changes) {
    const next = JSON.parse(JSON.stringify(prog));
    const applied = [];
    changes.forEach(c => {
        const day = next.days && next.days[c.dayIndex];
        if (!day || !Array.isArray(day.exercises)) return;
        const ex = day.exercises.find(e => e && canonicalName(e.name) === canonicalName(c.name));
        if (!ex) return;
        if (normaliseRole(ex.role) === 'warmup') return; // always one set
        ex.baseSets = c.to;
        applied.push(c);
    });
    return { program: next, applied };
}

module.exports = {
    snapNames, anchorFor, restoreCompletedDays, lockWarmups, diffSets,
    wantsFuture, applySetChangesToProgram
};
