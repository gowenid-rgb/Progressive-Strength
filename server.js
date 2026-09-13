// Loads .env and hard-fails on missing required vars. Must come first: every module
// below assumes process.env is already populated.
require('./config');
const express = require('express');
const path = require('path');
const {
    generateJSON, validatePlan, validateRecap, PLAN_SCHEMA, RECAP_SCHEMA
} = require('./aiClient');
const db = require('./db');
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

// User Data Sync Endpoints
app.get('/api/user/data', authenticateToken, async (req, res) => {
    try {
        const result = await db.query('SELECT current_plan, workout_journal FROM user_data WHERE user_id = $1', [req.user.id]);
        if (result.rows.length === 0) return res.json({ currentPlan: null, workoutJournal: [] });
        res.json({
            currentPlan: result.rows[0].current_plan,
            workoutJournal: result.rows[0].workout_journal || []
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch user data' });
    }
});

app.post('/api/user/data', authenticateToken, async (req, res) => {
    try {
        const { currentPlan, workoutJournal } = req.body;

        // Upsert rather than UPDATE: an UPDATE against a missing row affects zero rows
        // and reports success, silently discarding the user's data forever.
        const result = await db.query(
            `INSERT INTO user_data (user_id, current_plan, workout_journal)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE
                SET current_plan     = EXCLUDED.current_plan,
                    workout_journal  = EXCLUDED.workout_journal`,
            [
                req.user.id,
                currentPlan ? JSON.stringify(currentPlan) : null,
                JSON.stringify(workoutJournal || [])
            ]
        );

        // A save that wrote nothing must never report success.
        if (result.rowCount !== 1) {
            console.error(`Save for user ${req.user.id} affected ${result.rowCount} rows, expected 1`);
            return res.status(500).json({ error: 'Save did not persist' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save user data' });
    }
});

// Endpoint to generate a workout plan
app.post('/api/generate-plan', authenticateToken, aiLimiters, async (req, res) => {
    try {
        const { primaryGoal, experienceLevel, equipment, trainingDays, extraDetails, workoutHistory, journalEntries } = req.body;

        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is missing on the server.' });
        }

        const prompt = `You are an expert AI strength and conditioning coach.

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

Create a highly effective 1-week workout plan tailored to this user. 
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
