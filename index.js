const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// AI Generation endpoint
app.post('/generate', async (req, res) => {
  const keys = [process.env.GROQ_KEY, process.env.GROQ_KEY2].filter(Boolean);
  let lastError = null;
  for (const key of keys) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key
        },
        body: JSON.stringify(req.body)
      });
      const data = await response.json();
      if (response.ok) return res.json(data);
      lastError = data;
    } catch(err) {
      lastError = { error: err.message };
    }
  }
  res.status(500).json(lastError);
});

// ElevenLabs TTS endpoint
app.post('/tts', async (req, res) => {
  const { text, voice_id } = req.body;
  const key = process.env.ELEVENLABS_KEY;
  if (!key) return res.status(500).json({ error: 'No ElevenLabs key' });
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id || 'pNInz6obpgDQGcFmaJgB'}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': key
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });
    if (!response.ok) {
      const err = await response.json();
      return res.status(500).json(err);
    }
    const buffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Disposition', 'attachment; filename="narration.mp3"');
    res.send(Buffer.from(buffer));
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Pixabay video search endpoint
app.get('/videos', async (req, res) => {
  const { q } = req.query;
  const key = process.env.PIXABAY_KEY;
  if (!key) return res.status(500).json({ error: 'No Pixabay key' });
  try {
    const response = await fetch(
      `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(q)}&per_page=6&video_type=film&safesearch=true`
    );
    const data = await response.json();
    res.json(data);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => res.send('VideoKit API Running'));

app.listen(process.env.PORT || 3000);
