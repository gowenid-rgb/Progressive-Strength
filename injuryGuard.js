// Keeps movements away from a joint the lifter says is hurt.
//
// Found in the AI sandbox: told about a sore knee, the local model wrote "knee-safe" plans and
// still added step-ups, even with step-ups named in the prompt. Wording alone does not stop it,
// so the server checks every programme it is about to save. Narrow on purpose: a short list of
// joints and the movements that load them most, matched by name.
const JOINTS = [
    {
        joint: 'knee',
        mentioned: /\bknees?\b|\bacl\b|\bmcl\b|\bmeniscus\b|patell/i,
        avoid: /lunge|split squat|step[- ]?ups?\b|jump|plyo|bound|pistol|sissy squat|leg extension/i
    },
    {
        joint: 'shoulder',
        mentioned: /\bshoulders?\b|rotator cuff|\bimpingement\b/i,
        avoid: /overhead press|military press|push press|upright row|\bdips?\b|behind[- ]the[- ]neck|snatch|handstand/i
    },
    {
        joint: 'lower back',
        mentioned: /lower back|\bbad back\b|\bsciatica\b|\bdisc\b|lumbar/i,
        avoid: /good morning|jefferson curl|barbell row|bent[- ]over row|conventional deadlift/i
    }
];

/** Joints the lifter has mentioned, from any of the given texts (notes, journal entries). */
function injuredJoints(texts) {
    const all = [].concat(texts || []).filter(t => typeof t === 'string').join('\n');
    return JOINTS.filter(j => j.mentioned.test(all));
}

/** Movements in a programme (or a week plan) that load an injured joint: [{ name, joint }]. */
function offendingMovements(plan, joints) {
    const out = [];
    if (!plan || !Array.isArray(plan.days) || !joints || !joints.length) return out;
    plan.days.forEach(d => (Array.isArray(d && d.exercises) ? d.exercises : []).forEach(e => {
        const name = e && typeof e.name === 'string' ? e.name : '';
        const hit = joints.find(j => j.avoid.test(name));
        if (hit && !out.some(o => o.name === name)) out.push({ name, joint: hit.joint });
    }));
    return out;
}

/** Last resort: drops offending movements, but never empties a day. Returns the names removed. */
function removeOffending(plan, joints) {
    const removed = [];
    (plan && Array.isArray(plan.days) ? plan.days : []).forEach(d => {
        if (!d || !Array.isArray(d.exercises)) return;
        const keep = d.exercises.filter(e => !joints.some(j => j.avoid.test(String(e && e.name || ''))));
        if (keep.length && keep.length < d.exercises.length) {
            d.exercises.filter(e => !keep.includes(e)).forEach(e => removed.push(e.name));
            d.exercises = keep;
        }
    });
    return removed;
}

module.exports = { injuredJoints, offendingMovements, removeOffending, JOINTS };
