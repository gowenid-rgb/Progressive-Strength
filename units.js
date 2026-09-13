// Parsing for the free-text weight and reps the workout logger collects.
//
// The logger accepts whatever the user types — "225", "225 lbs", "100kg", "BW". None of
// that can be summed, averaged or plotted, which is why the Metrics tab could never be
// more than an AI paragraph.
//
// Every function here returns the parsed value AND the original string. Callers store
// both. If a parse is wrong or a format is unsupported, the record of what the user
// actually did is still intact and can be re-parsed later.
//
// Unparseable is not an error. It returns a null value with the raw text preserved, and
// the set still gets logged — losing the set would be far worse than losing the number.

const BODYWEIGHT = /^(bw|body\s*-?\s*weight)$/i;
const WEIGHT = /^(\d+(?:\.\d+)?)\s*(kgs?|kilos?|kilograms?|lbs?|pounds?)?$/i;

const DEFAULT_UNIT = 'lb';

/**
 * @returns {{value: number|null, unit: string|null, isBodyweight: boolean, raw: string}}
 */
function parseWeight(raw, defaultUnit = DEFAULT_UNIT) {
    const text = (raw === null || raw === undefined ? '' : String(raw)).trim();
    const miss = extra => Object.assign({ value: null, unit: null, isBodyweight: false, raw: text }, extra);

    if (text === '') return miss();
    if (BODYWEIGHT.test(text)) return miss({ isBodyweight: true });

    const m = text.match(WEIGHT);
    if (!m) return miss(); // e.g. "BW+25", "a bit lighter" — keep the record, skip the number

    const unit = m[2]
        ? (/^k/i.test(m[2]) ? 'kg' : 'lb')
        : defaultUnit;

    return { value: parseFloat(m[1]), unit, isBodyweight: false, raw: text };
}

/**
 * Logged reps should be a single number, but users type ranges ("8-10") and words
 * ("AMRAP"). Takes the first integer present, which is the right reading of "8-10 reps
 * done" far more often than not, and null when there is no number at all.
 *
 * @returns {{value: number|null, raw: string}}
 */
function parseReps(raw) {
    const text = (raw === null || raw === undefined ? '' : String(raw)).trim();
    if (text === '') return { value: null, raw: text };

    const m = text.match(/\d+/);
    return { value: m ? parseInt(m[0], 10) : null, raw: text };
}

const LB_PER_KG = 2.2046226218;

/** Converts for display and aggregation only. Never written back over stored values. */
function toUnit(value, fromUnit, toUnitName) {
    if (value === null || value === undefined) return null;
    if (!fromUnit || fromUnit === toUnitName) return value;
    return fromUnit === 'kg' ? value * LB_PER_KG : value / LB_PER_KG;
}

/**
 * Volume for one set, in the requested unit. Bodyweight sets contribute nothing, because
 * the app does not know the user's bodyweight — counting them as zero understates volume,
 * but inventing a number would corrupt the very history the AI reads.
 */
function setVolume(set, unit = DEFAULT_UNIT) {
    if (!set || set.is_bodyweight) return 0;
    const w = toUnit(set.weight_value === null ? null : Number(set.weight_value), set.weight_unit, unit);
    if (w === null || set.reps_value === null || set.reps_value === undefined) return 0;
    return w * set.reps_value;
}

module.exports = { parseWeight, parseReps, toUnit, setVolume, DEFAULT_UNIT, LB_PER_KG };
