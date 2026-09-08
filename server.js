require('dotenv').config();
const express = require('express');
const path = require('path');
const { OpenAI } = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint to generate a workout plan
app.post('/api/generate-plan', async (req, res) => {
    try {
        const { primaryGoal, experienceLevel, equipment, trainingDays, extraDetails } = req.body;

        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({ error: 'OpenAI API Key is missing on the server.' });
        }

        const prompt = `You are an expert AI strength and conditioning coach.

User Profile:
- Goal: 
- Experience: 
- Equipment: 
- Training Days per Week: 
- Extra Details: 

Create a highly effective 1-week workout plan tailored to this user. Return the plan STRICTLY as a JSON object with this schema:
{
  "planName": "String",
  "week": 1,
  "days": [
    {
      "dayName": "String (e.g., Day 1 - Upper Body Push)",
      "exercises": [
        {
          "name": "String",
          "sets": 3,
          "reps": "String (e.g., 8-10)"
        }
      ]
    }
  ]
}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
        });

        const plan = JSON.parse(response.choices[0].message.content);
        res.json(plan);

    } catch (error) {
        console.error('Error generating plan:', error);
        res.status(500).json({ error: 'Failed to generate plan' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
