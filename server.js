require('dotenv').config();
const express = require('express');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini (New SDK)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint to generate a workout plan
app.post('/api/generate-plan', async (req, res) => {
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
2. For main working sets, if the user has past performance history for a movement, suggest a challenging but realistic weight. If it's a new movement, leave suggestedWeight blank or null.
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
          "suggestedWeight": "String (e.g., '135 lbs', or null if warmup/new)"
        }
      ]
    }
  ]
}`;

        const response = await ai.interactions.create({
            model: 'gemini-3.8-flash',
            input: prompt
        });

        let textResult = response.outputText || response.output_text || response.text;
        
        // Strip markdown if the AI accidentally includes it
        if (textResult.startsWith('\`\`\`json')) {
            textResult = textResult.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '');
        }

        const plan = JSON.parse(textResult.trim());
        
        res.json(plan);

    } catch (error) {
        console.error('Error generating plan:', error);
        res.status(500).json({ error: error.message || 'Failed to generate plan' });
    }
});

// Endpoint to recalibrate an existing workout plan
app.post('/api/recalibrate-plan', async (req, res) => {
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
2. For main working sets, if the user has past performance history for a movement, suggest a challenging but realistic weight based on their history. If it's a new movement, leave suggestedWeight blank or null.
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
          "suggestedWeight": "String (e.g., '135 lbs', or null if warmup/new)"
        }
      ]
    }
  ]
}`;

        const response = await ai.interactions.create({
            model: 'gemini-3.8-flash',
            input: prompt
        });

        let textResult = response.outputText || response.output_text || response.text;
        
        // Strip markdown if the AI accidentally includes it
        if (textResult.startsWith('\`\`\`json')) {
            textResult = textResult.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '');
        }

        const updatedPlan = JSON.parse(textResult.trim());
        
        res.json(updatedPlan);

    } catch (error) {
        console.error('Error recalibrating plan:', error);
        res.status(500).json({ error: error.message || 'Failed to recalibrate plan' });
    }
});

// Endpoint to generate a weekly recap
app.post('/api/generate-recap', async (req, res) => {
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

        const response = await ai.interactions.create({
            model: 'gemini-3.8-flash',
            input: prompt
        });

        let textResult = response.outputText || response.output_text || response.text;
        
        if (textResult.startsWith('\`\`\`json')) {
            textResult = textResult.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '');
        }

        const recap = JSON.parse(textResult.trim());
        res.json(recap);

    } catch (error) {
        console.error('Error generating recap:', error);
        res.status(500).json({ error: error.message || 'Failed to generate recap' });
    }
});

// Endpoint to list available models for debugging
app.get('/api/models', (req, res) => {
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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
