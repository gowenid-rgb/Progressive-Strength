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
        const { primaryGoal, experienceLevel, equipment, trainingDays, extraDetails } = req.body;

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

Create a highly effective 1-week workout plan tailored to this user. 
IMPORTANT: You MUST return the plan STRICTLY as a raw JSON object. Do not include markdown formatting, do not include \`\`\`json blocks. Just the raw JSON object.
Schema requirement:
{
  "planName": "String",
  "week": 1,
  "days": [
    {
      "dayName": "String",
      "exercises": [
        {
          "name": "String",
          "sets": 3,
          "reps": "String"
        }
      ]
    }
  ]
}`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt
        });

        let textResult = response.text;
        
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
