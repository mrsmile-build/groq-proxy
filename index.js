const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

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

app.get('/', (req, res) => res.send('Groq Proxy Running'));
app.listen(process.env.PORT || 3000);
