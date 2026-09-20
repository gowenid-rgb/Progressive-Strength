// The programme: a cycle's design, authored once and referenced by every week in it.
//
// Before this, each week was an independent model call handed a phase label. Week 4 was not
// week 4 of anything — it was a fresh week wearing a "Peak" badge. That is what let movement
// names drift between weeks, made deloads a hope rather than a plan, and left progression
// impossible to explain because the reasoning lived in a prompt that had been discarded.
//
// Now the model designs the arc ONCE: the split, the movements, the progression rule, and what
// each week is for. Weeks are then RENDERED from it. Rendering is arithmetic — given the rule
// and what was actually lifted, next week's prescription is a calculation, not a judgement.
// That makes weeks instant, free, and auditable: the app can say why a weight moved.

const { phaseForWeek, PHASES } = require('./cycles');

/* ------------------------------------------------------------------ parsing */

/** "6-8" -> {min:6,max:8};  "5" -> {min:5,max:5};  "AMRAP" -> null */
function parseRepRange(reps) {
    const text = String(reps === null || reps === undefined ? '' : reps).trim();
    const range = text.match(/^(\d+)\s*[-–—to]+\s*(\d+)/i);
    if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
    const single = text.match(/^(\d+)/);
    if (single) return { min: parseInt(single[1], 10), max: parseInt(single[1], 10) };
    return null; // time-based, AMRAP, or anything else we should not do maths on
}

/* -------------------------------------------------------------- progression */

// Upper-body lifts move in smaller jumps than lower-body ones. A 10 lb week-on-week jump on a
// press is not progression, it is a stall waiting to happen.
const LOWER_BODY = /squat|deadlift|lunge|leg press|hip thrust|good morning|split squat|step up|calf/i;

function incrementFor(exerciseName, program) {
    const p = (program && program.progression) || {};
    const isLower = LOWER_BODY.test(String(exerciseName || ''));
    const configured = isLower ? p.incrementLower : p.incrementUpper;
    const n = Number(configured);
    if (Number.isFinite(n) && n > 0) return n;
    return isLower ? 10 : 5;
}

/**
 * The most recent logged session for an exercise, as { weight, reps[], allAtTop }.
 * Returns null when the movement has never been logged, which is how a new lift ends up with
 * a blank prescription rather than an invented one.
 */
function lastSessionFor(exerciseName, history) {
    if (!Array.isArray(history)) return null;
    const target = String(exerciseName || '').trim().toLowerCase();

    for (let i = history.length - 1; i >= 0; i--) {
        const w = history[i];
        const exercises = (w && Array.isArray(w.exercises)) ? w.exercises : [];
        const match = exercises.find(e => e && String(e.name || '').trim().toLowerCase() === target);
        if (!match || !Array.isArray(match.sets) || match.sets.length === 0) continue;

        const sets = match.sets
            .map(sx => ({
                weight: sx.weightValue === null || sx.weightValue === undefined ? null : Number(sx.weightValue),
                reps: sx.repsValue === null || sx.repsValue === undefined ? null : Number(sx.repsValue),
                isBodyweight: !!sx.isBodyweight,
                raw: sx.weight
            }))
            .filter(sx => sx.reps !== null);

        if (sets.length === 0) continue;
        return { date: w.date, sets };
    }
    return null;
}

/**
 * Next week's prescription for one movement.
 *
 * The rule is double progression: work up the rep range at a fixed load, and add weight only
 * once every set has reached the top of the range. Deliberately conservative — prescribing a
 * jump the lifter has not earned is how a programme stops being followable.
 *
 * Returns { suggestedWeight, reason } where reason explains the number in plain language, so
 * progression can be shown rather than asserted.
 */
function prescribeWeight(exercise, program, history, weekSpec) {
    const range = parseRepRange(exercise.repRange || exercise.reps);
    const last = lastSessionFor(exercise.name, history);

    if (!last) {
        return { suggestedWeight: null, reason: 'First time on this movement — find a working weight.' };
    }

    const working = last.sets.filter(s => s.weight !== null);
    if (working.length === 0) {
        return { suggestedWeight: null, reason: 'Logged as bodyweight last time.' };
    }

    const topWeight = Math.max(...working.map(s => s.weight));
    const atTop = working.filter(s => s.weight === topWeight);

    // A deload cuts load deliberately; it is not a failure to progress.
    if (weekSpec && weekSpec.phase === 'deload') {
        const reduced = Math.round((topWeight * 0.85) / 5) * 5;
        return {
            suggestedWeight: reduced + ' lbs',
            reason: 'Deload — about 15% off your ' + topWeight + ' lb top set.'
        };
    }

    if (!range) {
        return { suggestedWeight: topWeight + ' lbs', reason: 'Matching last session.' };
    }

    const allHitTop = atTop.every(s => s.reps >= range.max);
    if (allHitTop) {
        const inc = incrementFor(exercise.name, program);
        return {
            suggestedWeight: (topWeight + inc) + ' lbs',
            reason: 'Up ' + inc + ' lb — you hit ' + range.max + ' reps on every set at ' + topWeight + ' lb.'
        };
    }

    const best = Math.max(...atTop.map(s => s.reps));
    return {
        suggestedWeight: topWeight + ' lbs',
        reason: 'Hold ' + topWeight + ' lb — got ' + best + ' of ' + range.max + ' reps. Add weight once all sets reach ' + range.max + '.'
    };
}

/* ----------------------------------------------------------------- rendering */

function weekSpecFor(program, weekNumber) {
    const weeks = Array.isArray(program.weeks) ? program.weeks : [];
    const found = weeks.find(w => Number(w.week) === Number(weekNumber));
    if (found) return found;

    // A programme missing a spec for this week still has to produce something sane.
    const phase = phaseForWeek(weekNumber, program.totalWeeks);
    return { week: weekNumber, phase, intent: PHASES[phase] ? PHASES[phase].blurb : '', setAdjustment: 0 };
}

/**
 * Builds week `weekNumber` of `program`, in the same plan shape the app already renders, so
 * the workout player and plan screen need no changes.
 */
function renderWeek(program, weekNumber, history) {
    const spec = weekSpecFor(program, weekNumber);
    const days = Array.isArray(program.days) ? program.days : [];

    return {
        planName: program.programName || 'Training Week',
        week: weekNumber,
        totalWeeks: program.totalWeeks,
        phase: spec.phase,
        days: days.map(day => ({
            dayName: day.dayName,
            workoutIntro: spec.intent || day.focus || '',
            exercises: (Array.isArray(day.exercises) ? day.exercises : []).map(ex => {
                const baseSets = Number(ex.baseSets) || 3;
                const adjust = Number(spec.setAdjustment) || 0;
                const sets = Math.max(1, baseSets + adjust);
                const { suggestedWeight, reason } = prescribeWeight(ex, program, history, spec);

                const out = {
                    name: ex.name,
                    sets,
                    reps: ex.repRange || ex.reps || '8-10'
                };
                // Warmups and mobility carry no load, and a suggested weight on them is noise.
                if (ex.role !== 'warmup' && suggestedWeight) out.suggestedWeight = suggestedWeight;
                if (reason) out.progressionNote = reason;
                return out;
            })
        }))
    };
}

/* ------------------------------------------------------------------- schema */

const PROGRAM_SCHEMA = {
    type: 'object',
    properties: {
        programName: { type: 'string' },
        rationale: { type: 'string' },
        progression: {
            type: 'object',
            properties: {
                rule: { type: 'string' },
                incrementUpper: { type: 'number' },
                incrementLower: { type: 'number' }
            },
            required: ['rule']
        },
        days: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    dayName: { type: 'string' },
                    focus: { type: 'string' },
                    exercises: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                role: { type: 'string' },
                                repRange: { type: 'string' },
                                baseSets: { type: 'integer' }
                            },
                            required: ['name', 'repRange', 'baseSets']
                        }
                    }
                },
                required: ['dayName', 'exercises']
            }
        },
        weeks: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    week: { type: 'integer' },
                    phase: { type: 'string' },
                    intent: { type: 'string' },
                    setAdjustment: { type: 'integer' }
                },
                required: ['week', 'phase', 'intent']
            }
        }
    },
    required: ['programName', 'days', 'weeks', 'progression']
};

function validateProgram(p, expectedWeeks) {
    if (!p || typeof p !== 'object') return 'not an object';
    if (!Array.isArray(p.days) || p.days.length === 0) return 'days is empty';
    if (!Array.isArray(p.weeks) || p.weeks.length === 0) return 'weeks is empty';
    if (!p.progression || typeof p.progression.rule !== 'string' || !p.progression.rule.trim()) {
        return 'missing progression rule';
    }

    for (let i = 0; i < p.days.length; i++) {
        const d = p.days[i];
        if (!d || typeof d.dayName !== 'string' || !d.dayName.trim()) return `day ${i} has no name`;
        if (!Array.isArray(d.exercises) || d.exercises.length === 0) return `day ${i} has no exercises`;
        for (let j = 0; j < d.exercises.length; j++) {
            const e = d.exercises[j];
            if (!e || typeof e.name !== 'string' || !e.name.trim()) return `day ${i} exercise ${j} has no name`;
        }
    }

    // A six-week programme that only describes four weeks leaves weeks five and six with no
    // plan, which is the failure this whole design exists to prevent.
    if (expectedWeeks) {
        const covered = new Set(p.weeks.map(w => Number(w.week)));
        for (let w = 1; w <= expectedWeeks; w++) {
            if (!covered.has(w)) return `week ${w} of ${expectedWeeks} is missing from the plan`;
        }
    }
    return null;
}

/** Every movement in the programme, for naming stability and swap handling. */
function programExerciseNames(program) {
    if (!program || !Array.isArray(program.days)) return [];
    const out = [];
    program.days.forEach(d => (Array.isArray(d.exercises) ? d.exercises : []).forEach(e => {
        if (e && e.name) out.push(e.name);
    }));
    return out;
}

module.exports = {
    renderWeek, prescribeWeight, lastSessionFor, parseRepRange, incrementFor,
    weekSpecFor, validateProgram, programExerciseNames, PROGRAM_SCHEMA
};
