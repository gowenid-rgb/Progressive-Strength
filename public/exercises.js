/*
 * Movement-pattern substitution library.
 *
 * Decision D7: static, not AI. A swap happens mid-workout between sets — a ten-second API
 * round trip is the wrong thing to put there. This is instant, works offline, and costs
 * nothing. An AI fallback for unrecognised movements is a reasonable later addition.
 *
 * Matching is by movement pattern rather than exact name, because exercise names come from
 * a language model and vary: "Barbell Bench Press", "Bench Press (Barbell)", "Flat Barbell
 * Press" are all the same movement.
 *
 * Loaded as a plain script in the browser (window.ExerciseLibrary) and required directly in
 * tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ExerciseLibrary = factory();
}(typeof self !== 'undefined' ? self : this, function () {

    // Order matters: the first pattern whose keywords match wins, so more specific patterns
    // must precede more general ones. "lat pulldown" has to be tested before "pulldown",
    // and "romanian deadlift" before "deadlift", or hinges get classified as squats.
    const PATTERNS = [
        {
            id: 'vertical-pull',
            keywords: ['pull up', 'pull-up', 'pullup', 'chin up', 'chin-up', 'chinup', 'lat pulldown', 'pulldown', 'pull down'],
            alternatives: ['Lat Pulldown', 'Assisted Pull Up', 'Band-Assisted Pull Up', 'Neutral-Grip Pulldown', 'Straight-Arm Pulldown']
        },
        {
            id: 'horizontal-pull',
            keywords: ['barbell row', 'bent over row', 'bent-over row', 'cable row', 'seated row', 'dumbbell row', 'chest supported row', 't-bar', 'pendlay'],
            alternatives: ['Seated Cable Row', 'Chest-Supported Row', 'Single-Arm Dumbbell Row', 'T-Bar Row', 'Inverted Row']
        },
        {
            id: 'hinge',
            keywords: ['romanian deadlift', 'rdl', 'deadlift', 'good morning', 'hip thrust', 'glute bridge', 'back extension', 'hip hinge'],
            alternatives: ['Romanian Deadlift', 'Trap Bar Deadlift', 'Hip Thrust', 'Back Extension', 'Cable Pull-Through']
        },
        {
            id: 'squat',
            keywords: ['back squat', 'front squat', 'goblet squat', 'hack squat', 'leg press', 'squat'],
            alternatives: ['Goblet Squat', 'Front Squat', 'Hack Squat', 'Leg Press', 'Bulgarian Split Squat']
        },
        {
            id: 'lunge',
            keywords: ['lunge', 'split squat', 'step up', 'step-up'],
            alternatives: ['Walking Lunge', 'Reverse Lunge', 'Bulgarian Split Squat', 'Step Up', 'Leg Press']
        },
        {
            id: 'vertical-push',
            keywords: ['overhead press', 'shoulder press', 'military press', 'push press', 'arnold press'],
            alternatives: ['Seated Dumbbell Shoulder Press', 'Machine Shoulder Press', 'Landmine Press', 'Arnold Press', 'Push Press']
        },
        {
            id: 'horizontal-push',
            keywords: ['bench press', 'chest press', 'push up', 'push-up', 'pushup', 'dip', 'chest fly', 'cable fly', 'pec deck'],
            alternatives: ['Dumbbell Bench Press', 'Incline Dumbbell Press', 'Machine Chest Press', 'Push Up', 'Cable Fly']
        },
        {
            id: 'hamstring',
            keywords: ['leg curl', 'hamstring curl', 'nordic'],
            alternatives: ['Seated Leg Curl', 'Lying Leg Curl', 'Nordic Curl', 'Romanian Deadlift', 'Cable Pull-Through']
        },
        {
            id: 'quad-isolation',
            keywords: ['leg extension', 'quad extension'],
            alternatives: ['Leg Extension', 'Goblet Squat', 'Bulgarian Split Squat', 'Leg Press']
        },
        {
            id: 'lateral-delt',
            keywords: ['lateral raise', 'side raise', 'side lateral', 'rear delt', 'face pull', 'reverse fly'],
            alternatives: ['Dumbbell Lateral Raise', 'Cable Lateral Raise', 'Machine Lateral Raise', 'Face Pull', 'Reverse Pec Deck']
        },
        {
            id: 'biceps',
            keywords: ['curl'],   // after leg curl / hamstring curl, so this is arm curls
            alternatives: ['Dumbbell Curl', 'Barbell Curl', 'Hammer Curl', 'Cable Curl', 'Incline Dumbbell Curl']
        },
        {
            id: 'triceps',
            keywords: ['tricep', 'skull crusher', 'skullcrusher', 'pushdown', 'push down', 'overhead extension', 'close grip bench'],
            alternatives: ['Cable Tricep Pushdown', 'Overhead Cable Extension', 'Skull Crusher', 'Close-Grip Bench Press', 'Dip']
        },
        {
            id: 'calf',
            keywords: ['calf'],
            alternatives: ['Standing Calf Raise', 'Seated Calf Raise', 'Leg Press Calf Raise']
        },
        {
            id: 'core',
            keywords: ['plank', 'crunch', 'sit up', 'sit-up', 'leg raise', 'ab wheel', 'russian twist', 'hollow', 'dead bug', 'pallof'],
            alternatives: ['Plank', 'Hanging Leg Raise', 'Cable Crunch', 'Ab Wheel Rollout', 'Pallof Press']
        },
        {
            id: 'carry',
            keywords: ['farmer', 'carry', 'suitcase'],
            alternatives: ["Farmer's Carry", 'Suitcase Carry', 'Front Rack Carry']
        }
    ];

    function normalise(name) {
        return String(name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function patternFor(name) {
        const n = normalise(name);
        if (!n) return null;
        for (const p of PATTERNS) {
            for (const k of p.keywords) {
                if (n.indexOf(normalise(k)) !== -1) return p;
            }
        }
        return null;
    }

    /**
     * Suggested replacements for `name`, excluding the movement itself.
     * Returns [] for anything unrecognised — the UI always offers "enter your own", so an
     * empty list degrades to free text rather than to a dead end.
     */
    function alternativesFor(name) {
        const p = patternFor(name);
        if (!p) return [];
        const n = normalise(name);
        return p.alternatives.filter(a => normalise(a) !== n);
    }

    return { PATTERNS, alternativesFor, patternFor, normalise };
}));
