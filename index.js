const express = require('express');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const tmp = require('tmp');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => res.send('VideoKit API Running'));

// ── AI Script Generation ──────────────────────────────────────
app.post('/generate', async (req, res) => {
  const keys = [process.env.GROQ_KEY, process.env.GROQ_KEY2].filter(Boolean);
  let lastError = null;
  for (const key of keys) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify(req.body)
      });
      const data = await response.json();
      if (response.ok) return res.json(data);
      lastError = data;
    } catch(err) { lastError = { error: err.message }; }
  }
  res.status(500).json(lastError);
});

// ── Smart Video Search ────────────────────────────────────────
// q = comma-separated keywords, duration = total video seconds
// Clip options per scene:
// 30s=4 | 60s=6 | 2min=8 | 5min=12 | 10min=16
app.get('/videos', async (req, res) => {
  const { q, duration } = req.query;
  const key = process.env.PIXABAY_KEY;
  if (!key) return res.status(500).json({ error: 'No Pixabay key' });

  const secs = parseInt(duration) || 60;
  let perScene;
  if      (secs <= 30)  perScene = 4;
  else if (secs <= 60)  perScene = 6;
  else if (secs <= 120) perScene = 8;
  else if (secs <= 300) perScene = 12;
  else if (secs <= 600) perScene = 16;
  else                  perScene = 20;

  const keywords = (q || 'business').split(',').map(k => k.trim()).filter(Boolean).slice(0, 5);
  const perPage  = Math.min(Math.ceil((perScene * 1.8) / keywords.length) + 2, 20);

  console.log(`[Videos] ${secs}s -> ${perScene} per scene | [${keywords.join(', ')}]`);

  try {
    const promises = keywords.map(keyword =>
      fetch(`https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(keyword)}&per_page=${perPage}&video_type=film&safesearch=true`)
        .then(r => r.json()).then(d => d.hits || []).catch(() => [])
    );
    const results = await Promise.all(promises);

    const seen = new Set(), merged = [];
    for (const hits of results) {
      for (const hit of hits) {
        if (!seen.has(hit.id)) { seen.add(hit.id); merged.push(hit); }
      }
    }

    // Shuffle for variety
    for (let i = merged.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [merged[i], merged[j]] = [merged[j], merged[i]];
    }

    res.json({ hits: merged.slice(0, perScene + 4), perScene, total: merged.length, keywords });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Multi-Layer TTS ───────────────────────────────────────────
// Layer 1: StreamElements (Amazon Polly — free, no key)
// Layer 2: Google Translate TTS
// Layer 3: JSON signal -> frontend uses Web Speech API
app.post('/tts-voicerss', async (req, res) => {
  const { text, voice } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });

  const safeText = text.slice(0, 300).replace(/"/g, "'");
  const encoded  = encodeURIComponent(safeText);

  const seVoiceMap = {
    'en-us':'Matthew', 'en-us-f':'Joanna',
    'en-gb':'Brian',   'en-gb-f':'Amy',
    'en-au':'Russell', 'en-au-f':'Nicole',
    'en-ca':'Matthew', 'en-in':'Aditi',
    'fr-fr':'Mathieu', 'fr-fr-f':'Celine',
    'de-de':'Hans',    'de-de-f':'Marlene',
    'es-es':'Enrique', 'es-es-f':'Conchita'
  };
  const langMap = {
    'en-us':'en','en-us-f':'en','en-gb':'en','en-gb-f':'en',
    'en-au':'en','en-au-f':'en','en-ca':'en','en-in':'en',
    'fr-fr':'fr','fr-fr-f':'fr','de-de':'de','de-de-f':'de',
    'es-es':'es','es-es-f':'es'
  };

  const seVoice = seVoiceMap[voice] || 'Matthew';
  const lang    = langMap[voice]    || 'en';

  // Layer 1: StreamElements
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 8000);
    const r    = await fetch(`https://api.streamelements.com/kv3/voice/${seVoice}/say/${encoded}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 1000) {
        res.set('Content-Type', 'audio/mpeg');
        res.set('X-TTS-Source', 'streamelements');
        return res.send(Buffer.from(buf));
      }
    }
  } catch(e) { console.warn('[TTS] StreamElements failed:', e.message); }

  // Layer 2: Google Translate TTS
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 8000);
    const r    = await fetch(
      `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=tw-ob`,
      { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://translate.google.com/' } }
    );
    clearTimeout(t);
    if (r.ok) {
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 500) {
        res.set('Content-Type', 'audio/mpeg');
        res.set('X-TTS-Source', 'google');
        return res.send(Buffer.from(buf));
      }
    }
  } catch(e) { console.warn('[TTS] Google TTS failed:', e.message); }

  // Layer 3: Signal frontend -> Web Speech API
  res.status(503).json({
    error: 'server_tts_unavailable', fallback: 'webspeech', text: safeText,
    lang: lang === 'fr' ? 'fr-FR' : lang === 'de' ? 'de-DE' : lang === 'es' ? 'es-ES' : 'en-US'
  });
});

// ── File download helper ──────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, response => {
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

// ── Video Merge ───────────────────────────────────────────────
app.post('/merge', async (req, res) => {
  const { videos } = req.body;
  if (!videos || videos.length === 0) return res.status(400).json({ error: 'No videos provided' });
  try {
    const tmpDir     = tmp.dirSync({ unsafeCleanup: true });
    const videoFiles = [];
    for (let i = 0; i < videos.length; i++) {
      const dest = `${tmpDir.name}/video${i}.mp4`;
      await downloadFile(videos[i], dest);
      videoFiles.push(dest);
    }
    const outputFile = `${tmpDir.name}/output.mp4`;
    const listFile   = `${tmpDir.name}/list.txt`;
    fs.writeFileSync(listFile, videoFiles.map(f => `file '${f}'`).join('\n'));
    await new Promise((resolve, reject) => {
      ffmpeg().input(listFile).inputOptions(['-f','concat','-safe','0'])
        .outputOptions(['-c','copy']).output(outputFile)
        .on('end', resolve).on('error', reject).run();
    });
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename="videokit.mp4"');
    fs.createReadStream(outputFile).pipe(res);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('VideoKit API running on port', process.env.PORT || 3000);
});
