// Loads .env and hard-fails on missing required vars. Must come first: every module
// below assumes process.env is already populated.
require('./config');
const express = require('express');
const path = require('path');
const {
    generateJSON, validatePlan, validateRecap, PLAN_SCHEMA, RECAP_SCHEMA
} = require('./aiClient');
const db = require('./db');
const repo = require('./repo');
const cycles = require('./cycles');
const authRoutes = require('./authRoutes');
const { authenticateToken } = require('./middleware');
const { aiLimiters, authLimiter } = require('./rateLimits');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Database
if (process.env.DATABASE_URL) {
    db.initDB();
} else {
    console.warn("No DATABASE_URL provided. Database will not initialize.");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Authentication Routes
app.use('/api/auth', authLimiter, authRoutes);

// ---------------------------------------------------------------- user data
//
// GET returns the active cycle's current week plan plus recent history, in the shape the
// client already renders. POST saves only the PLAN. Workouts and journal entries have their
// own append-only endpoints below — the old design sent the entire history blob on every
// save, which is what let a stale client wipe it (T1-1, T3-3).

app.get('/api/user/data', authenticateToken, async (req, res) => {
    try {
        const cycle = await repo.getActiveCycle(req.user.id);
        const weekPlan = cycle ? await repo.getWeekPlan(cycle.id, cycle.current_week) : null;

        res.json({
            currentPlan: weekPlan ? weekPlan.plan : null,
            workoutJournal: await repo.getWorkoutHistory(req.user.id),
            journalEntries: await repo.getJournalEntries(req.user.id),
            cycle: cycle ? {
                id: cycle.id,
                name: cycle.name,
                totalWeeks: cycle.total_weeks,
                currentWeek: cycle.current_week,
                status: cycle.status,
                // Computed server-side and shipped whole, so the timeline cannot drift from
                // the phase the prompt was actually given.
                phases: cycles.phasesForCycle(cycle.total_weeks)
            } : null
        });
    } catch (err) {
        console.error('Fetch user data failed:', err);
        res.status(500).json({ error: 'Failed to fetch user data' });
    }
});

// Saves the current week's plan. Creates a cycle on first save so a user who generated a
// plan before cycles existed as a concept still gets one.
app.post('/api/user/data', authenticateToken, async (req, res) => {
    try {
        const { currentPlan, cycleOptions } = req.body;

        if (!currentPlan) {
            // No plan means the user reset. Retire the cycle; history is deliberately kept.
            await repo.endActiveCycle(req.user.id, 'abandoned');
            return res.json({ success: true, cycle: null });
        }

        let cycle = await repo.getActiveCycle(req.user.id);
        if (!cycle) {
            cycle = await repo.startCycle(req.user.id, Object.assign(
                { name: currentPlan.planName, totalWeeks: 1 },
                cycleOptions || {}
            ));
        }

        await repo.saveWeekPlan(cycle.id, cycle.current_week, currentPlan, { status: 'active' });

        res.json({
            success: true,
            cycle: { id: cycle.id, totalWeeks: cycle.total_weeks, currentWeek: cycle.current_week }
        });
    } catch (err) {
        console.error('Save user data failed:', err);
        res.status(500).json({ error: 'Failed to save user data' });
    }
});

// Append-only. Finishing a workout inserts rows; nothing rewrites history. This is the
// structural fix for T3-3 — there is no longer a code path that can overwrite past sessions.
app.post('/api/workouts', authenticateToken, async (req, res) => {
    try {
        const workout = req.body || {};
        if (!Array.isArray(workout.exercises) || workout.exercises.length === 0) {
            return res.status(400).json({ error: 'A workout must contain at least one exercise' });
        }

        const cycle = await repo.getActiveCycle(req.user.id);
        const saved = await repo.appendWorkout(req.user.id, Object.assign({}, workout, {
            cycleId: cycle ? cycle.id : null,
            weekNumber: workout.weekNumber || (cycle ? cycle.current_week : null)
        }));

        res.status(201).json({ success: true, workoutId: saved.id });
    } catch (err) {
        console.error('Append workout failed:', err);
        res.status(500).json({ error: 'Failed to save workout' });
    }
});

// Check-in reflections, finally stored server-side (T3-2).
app.post('/api/journal', authenticateToken, async (req, res) => {
    try {
        const { energy, intentions } = req.body || {};
        if (!String(energy || '').trim() && !String(intentions || '').trim()) {
            return res.status(400).json({ error: 'Entry is empty' });
        }

        const cycle = await repo.getActiveCycle(req.user.id);
        const saved = await repo.appendJournalEntry(req.user.id, {
            cycleId: cycle ? cycle.id : null,
            weekNumber: cycle ? cycle.current_week : null,
            energy, intentions
        });

        res.status(201).json({ success: true, entryId: saved.id });
    } catch (err) {
        console.error('Append journal entry failed:', err);
        res.status(500).json({ error: 'Failed to save journal entry' });
    }
});

// Recommends a cycle length for users who pick "Not sure". A small, cheap call: the
// alternative is making someone guess at periodisation before they have trained once.
app.post('/api/recommend-cycle-length', authenticateToken, aiLimiters, async (req, res) => {
    try {
        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is missing on the server.' });
        }

        const { primaryGoal, experienceLevel, trainingDays, extraDetails } = req.body;

        const prompt = `You are an expert strength and conditioning coach.

Recommend a training cycle length in weeks for this lifter:
- Goal: ${primaryGoal || 'General fitness'}
- Experience: ${experienceLevel || 'Beginner'}
- Training days per week: ${trainingDays || 4}
- Notes: ${extraDetails || 'None'}

Guidance:
- Beginners adapt quickly and benefit from shorter cycles they can complete and repeat.
- Hypertrophy blocks generally need longer accumulation than pure strength peaking blocks.
- Anything from ${cycles.MIN_WEEKS} to ${cycles.MAX_WEEKS} weeks is valid. Most lifters do well between 4 and 8.
- The final week of cycles of 4 weeks or longer is a deload, so account for that.

Return the number of weeks and one short sentence explaining why, addressed to the lifter.`;

        const result = await generateJSON({
            prompt,
            schema: cycles.RECOMMENDATION_SCHEMA,
            validate: cycles.validateRecommendation,
            label: 'recommend-cycle-length'
        });

        const weeks = cycles.clampWeeks(result.weeks);
        res.json({ weeks, rationale: result.rationale, phases: cycles.phasesForCycle(weeks) });
    } catch (error) {
        console.error('Error recommending cycle length:', error);
        res.status(500).json({ error: error.message || 'Failed to recommend a cycle length' });
    }
});

// Advances the active cycle to its next week. Called when every day in the current week is
// complete; the client then generates the next week's plan.
app.post('/api/cycle/advance', authenticateToken, async (req, res) => {
    try {
        const cycle = await repo.getActiveCycle(req.user.id);
        if (!cycle) return res.status(400).json({ error: 'No active cycle' });

        if (cycle.current_week >= cycle.total_weeks) {
            await repo.endActiveCycle(req.user.id, 'completed');
            return res.json({ completed: true, cycle: null });
        }

        const updated = await repo.advanceCycleWeek(cycle.id);
        res.json({
            completed: false,
            cycle: {
                id: updated.id,
                totalWeeks: updated.total_weeks,
                currentWeek: updated.current_week,
                phases: cycles.phasesForCycle(updated.total_weeks)
            }
        });
    } catch (error) {
        console.error('Error advancing cycle:', error);
        res.status(500).json({ error: 'Failed to advance cycle' });
    }
});

// Endpoint to generate a workout plan
app.post('/api/generate-plan', authenticateToken, aiLimiters, async (req, res) => {
    try {
        const { primaryGoal, experienceLevel, equipment, trainingDays, extraDetails, workoutHistory, journalEntries } = req.body;

        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is missing on the server.' });
        }

        // Week and cycle length come from the active cycle when there is one, so generating
        // week 4 of 6 produces a week 4 of 6 rather than another week 1.
        const activeCycle = await repo.getActiveCycle(req.user.id);
        const totalWeeks = cycles.clampWeeks(req.body.totalWeeks || (activeCycle && activeCycle.total_weeks) || 6);
        const weekNumber = Math.min(
            (activeCycle && activeCycle.current_week) || 1,
            totalWeeks
        );

        const prompt = `You are an expert AI strength and conditioning coach.

${cycles.phaseGuidance(weekNumber, totalWeeks)}

User Profile:
- Goal: ${primaryGoal}
- Experience: ${experienceLevel}
- Equipment: ${equipment}
- Training Days per Week: ${trainingDays}
- Extra Details: ${extraDetails || 'None'}

Past Performance History (use to calculate suggested weights):
${workoutHistory ? JSON.stringify(workoutHistory) : 'None'}

Recent Journal Feedback (use to adjust exercises or cycle phase):
${journalEntries ? JSON.stringify(journalEntries) : 'None'}

Create the week ${weekNumber} training week of this ${totalWeeks}-week cycle, tailored to this user.
Programme it for the phase described above: a Base week and a Peak week of the same cycle should
not look the same. Set "week" to ${weekNumber} in your response.

Smart Programming Rules:
1. Warmups and mobility work should NOT have a suggested weight, and should have appropriate reps (e.g. 15-20 or time-based).
2. For main working sets, if the user has past performance history for a movement, suggest a challenging but realistic weight. If it's a new movement, omit suggestedWeight entirely.
3. Incorporate any feedback from their journal. If they mention an injury or fatigue, adjust the intensity, remove offending exercises, or program a deload week.

IMPORTANT: You MUST return the plan STRICTLY as a raw JSON object. Do not include markdown formatting, do not include \`\`\`json blocks. Just the raw JSON object.
Schema requirement:
{
  "planName": "String",
  "week": 1,
  "days": [
    {
      "dayName": "String",
      "workoutIntro": "String (A short motivational/instructional coaching blurb for the day, explaining the stimulus or goal)",
      "exercises": [
        {
          "name": "String",
          "sets": 3,
          "reps": "String",
          "suggestedWeight": "String (e.g., '135 lbs'). OMIT this field entirely for warmups and new movements - do not send null."
        }
      ]
    }
  ]
}`;

        const plan = await generateJSON({
            prompt,
            schema: PLAN_SCHEMA,
            validate: validatePlan,
            label: 'generate-plan'
        });

        // Authoritative, not advisory: the week is ours to decide, not the model's.
        plan.week = weekNumber;
        plan.totalWeeks = totalWeeks;
        plan.phase = cycles.phaseForWeek(weekNumber, totalWeeks);

        res.json(plan);

    } catch (error) {
        console.error('Error generating plan:', error);
        res.status(500).json({ error: error.message || 'Failed to generate plan' });
    }
});

// Endpoint to recalibrate an existing workout plan
app.post('/api/recalibrate-plan', authenticateToken, aiLimiters, async (req, res) => {
    try {
        const { currentPlan, feedback, workoutHistory } = req.body;

        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is missing on the server.' });
        }

        const prompt = `You are an expert AI strength and conditioning coach.

Here is the user's current 1-week workout plan:
${JSON.stringify(currentPlan, null, 2)}

The user provided the following feedback/request for changes:
"${feedback}"

Past Performance History (use to calculate suggested weights):
${workoutHistory ? JSON.stringify(workoutHistory) : 'None'}

Adjust the current plan according to the feedback while maintaining the exact same JSON schema. 
Smart Programming Rules:
1. Warmups and mobility work should NOT have a suggested weight, and should have appropriate reps.
2. For main working sets, if the user has past performance history for a movement, suggest a challenging but realistic weight based on their history. If it's a new movement, omit suggestedWeight entirely.
3. Incorporate the feedback heavily to modify exercises, intensities, or phase.

IMPORTANT: You MUST return the plan STRICTLY as a raw JSON object. Do not include markdown formatting, do not include \`\`\`json blocks. Just the raw JSON object.
Schema requirement:
{
  "planName": "String",
  "week": 1,
  "days": [
    {
      "dayName": "String",
      "workoutIntro": "String (A short motivational/instructional coaching blurb for the day, explaining the stimulus or goal)",
      "exercises": [
        {
          "name": "String",
          "sets": 3,
          "reps": "String",
          "suggestedWeight": "String (e.g., '135 lbs'). OMIT this field entirely for warmups and new movements - do not send null."
        }
      ]
    }
  ]
}`;

        const updatedPlan = await generateJSON({
            prompt,
            schema: PLAN_SCHEMA,
            validate: validatePlan,
            label: 'recalibrate-plan'
        });

        res.json(updatedPlan);

    } catch (error) {
        console.error('Error recalibrating plan:', error);
        res.status(500).json({ error: error.message || 'Failed to recalibrate plan' });
    }
});

// Endpoint to generate a weekly recap
app.post('/api/generate-recap', authenticateToken, aiLimiters, async (req, res) => {
    try {
        const { workoutHistory } = req.body;

        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is missing on the server.' });
        }

        const prompt = `You are an expert AI strength and conditioning coach.

Here is the user's completed workout history for the past cycle/week:
${workoutHistory ? JSON.stringify(workoutHistory, null, 2) : 'No workouts logged yet.'}

Analyze their performance. Calculate their consistency (how many workouts they completed), spot any volume/weight increases, and write a customized motivational recap. Forecast what their focus should be for the next week based on standard progressive overload (e.g. if they just hit hard workouts, maybe suggest a deload or peak phase).

IMPORTANT: You MUST return the response STRICTLY as a raw JSON object. Do not include markdown formatting, do not include \`\`\`json blocks.
Schema requirement:
{
  "recapTitle": "String (e.g., 'A Week of Heavy Lifting')",
  "recapMessage": "String (The detailed AI analysis and forecast, ~3 sentences)",
  "stats": [
    { "label": "String (e.g. 'Consistency')", "value": "String (e.g. '3/3 Workouts')" },
    { "label": "String (e.g. 'Volume Trend')", "value": "String (e.g. 'Up 5%')" }
  ]
}`;

        const recap = await generateJSON({
            prompt,
            schema: RECAP_SCHEMA,
            validate: validateRecap,
            label: 'generate-recap'
        });

        res.json(recap);

    } catch (error) {
        console.error('Error generating recap:', error);
        res.status(500).json({ error: error.message || 'Failed to generate recap' });
    }
});

// Endpoint to list available models for debugging
app.get('/api/models', authenticateToken, (req, res) => {
    // Debug aid only. It was previously unauthenticated, which let anyone enumerate the
    // models this key can reach. Behind auth now, and OFF unless explicitly in development --
    // fail closed, because we cannot rely on NODE_ENV being set in every environment.
    if (process.env.NODE_ENV !== 'development') {
        return res.status(404).json({ error: 'Not found' });
    }
    const https = require('https');
    https.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`, (apiRes) => {
        let data = '';
        apiRes.on('data', (chunk) => { data += chunk; });
        apiRes.on('end', () => {
            try {
                res.json(JSON.parse(data));
            } catch (err) {
                res.status(500).json({ error: 'Failed to parse JSON' });
            }
        });
    }).on("error", (err) => {
        res.status(500).json({ error: err.message });
    });
});

// Must precede the SPA catch-all: an unknown API route should be an honest 404, not an
// HTML document that the client fails to parse and reports as a network error.
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Unknown API endpoint: ' + req.method + ' /api' + req.path });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
