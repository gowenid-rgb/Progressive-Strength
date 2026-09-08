require('dotenv').config();
const express = require('express');
const path = require('path');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
- Goal: 
- Experience: 
- Equipment: 
- Training Days per Week: 
- Extra Details: 

Create a highly effective 1-week workout plan tailored to this user. Return the plan STRICTLY as a JSON object matching the requested schema.`;

        const schema = {
            type: SchemaType.OBJECT,
            properties: {
                planName: { type: SchemaType.STRING },
                week: { type: SchemaType.INTEGER },
                days: {
                    type: SchemaType.ARRAY,
                    items: {
                        type: SchemaType.OBJECT,
                        properties: {
                            dayName: { type: SchemaType.STRING, description: "e.g., Day 1 - Upper Body Push" },
                            exercises: {
                                type: SchemaType.ARRAY,
                                items: {
                                    type: SchemaType.OBJECT,
                                    properties: {
                                        name: { type: SchemaType.STRING },
                                        sets: { type: SchemaType.INTEGER },
                                        reps: { type: SchemaType.STRING, description: "e.g., 8-10" }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            required: ["planName", "week", "days"]
        };

        const model = genAI.getGenerativeModel({
            model: 'gemini-1.5-pro-latest',
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: schema,
            }
        });

        const result = await model.generateContent(prompt);
        const plan = JSON.parse(result.response.text());
        
        res.json(plan);

    } catch (error) {
        console.error('Error generating plan:', error);
        res.status(500).json({ error: error.message || 'Failed to generate plan' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
