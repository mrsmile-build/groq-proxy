const express = require('express');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const tmp = require('tmp');


function wrapTextArray(text, maxCharsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxCharsPerLine) {
      if (current.trim()) lines.push(current.trim());
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.slice(0, 6);
}

// Builds one drawtext filter PER LINE (more reliable than embedded \n
// escapes, which can break depending on how the filter string gets built).
function buildTextLines(rawText, maxCharsPerLine, fontsize, boxcolor, boxborderw, anchor, canvasH) {
  const lines = wrapTextArray(rawText, maxCharsPerLine);
  if (!lines.length) return [];
  const lineHeight = Math.round(fontsize * 1.35);
  const blockHeight = lines.length * lineHeight;
  const startY = anchor === 'center'
    ? Math.round((canvasH - blockHeight) / 2)
    : (canvasH - 60 - blockHeight); // 'bottom' anchor, 60px margin
  return lines.map((line, i) => ({
    filter: 'drawtext',
    options: {
      text: line,
      fontsize: fontsize,
      fontcolor: 'white',
      x: '(w-text_w)/2',
      y: String(startY + i * lineHeight),
      box: 1,
      boxcolor: boxcolor,
      boxborderw: boxborderw
    }
  }));
}

function watermarkFilter() {
  return {
    filter: 'drawtext',
    options: {
      text: 'VideoKit',
      fontsize: 20,
      fontcolor: 'white@0.75',
      x: 'w-text_w-16',
      y: '16',
      box: 1,
      boxcolor: 'black@0.3',
      boxborderw: 6
    }
  };
}

const app = express();

const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now();
  const window = 60000; // 1 minute
  const max = 20; // 20 requests per minute
  if (!rateLimit.has(ip)) rateLimit.set(ip, []);
  const times = rateLimit.get(ip).filter(t => now - t < window);
  if (times.length >= max) return false;
  times.push(now);
  rateLimit.set(ip, times);
  return true;
}


app.use(cors());
app.use(express.json({ limit: '50mb' }));

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => res.send('VideoKit API Running'));

// ── AI Script Generation ──────────────────────────────────────
app.post('/generate', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (!checkRate(ip)) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  const keys = [process.env.GROQ_KEY, process.env.GROQ_KEY2, process.env.GROQ_KEY3].filter(Boolean);
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

// ── Business Research (server-side fetch, no CORS) ──────────
app.post('/research', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.json({ context: '' });
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
      redirect: 'follow'
    });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('html') && !ct.includes('text')) return res.json({ context: 'Non-HTML response from ' + url });
    let html = await r.text();
    const grab = (re) => { const m = html.match(re); return m && m[1] ? m[1].trim() : ''; };
    const title = grab(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
    const desc = grab(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]{0,400}?)["']/i) ||
                 grab(/<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]{0,400}?)["']/i);
    const ogTitle = grab(/<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]{0,200}?)["']/i);
    const body = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    res.json({ context: ('URL: ' + url + ' | Title: ' + (ogTitle || title) + ' | Description: ' + desc + ' | Page text: ' + body.slice(0, 2500)) });
  } catch(e) {
    res.json({ context: '', error: 'Could not fetch URL: ' + e.message });
  }
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

app.post('/tts-voicerss', async (req, res) => {
  const { text, voice } = req.body;
  const cleanText = (text||'').replace(/\.\.\.+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text' });
  const safeText = cleanText.slice(0, 3000);

  // StreamElements Voice Map (Free, No Key, Amazon Polly voices via Twitch)
  const seVoiceMap = {
    'en-us-m': 'Joey', 'en-us-f': 'Ivy',
    'en-gb-m': 'Brian', 'en-gb-f': 'Amy',
    'en-au-m': 'Russell', 'en-au-f': 'Nicole',
    'en-news-m': 'Matthew', 'en-story-f': 'Joanna'
  };
  const seVoice = seVoiceMap[voice] || 'Joey';

  const words = safeText.split(' ');
  const chunks = [];
  let cur = '';
  for (const word of words) {
    if ((cur + ' ' + word).trim().length > 900) {
      if (cur.trim()) chunks.push(cur.trim());
      cur = word;
    } else {
      cur = cur ? cur + ' ' + word : word;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());

  console.log('[TTS] StreamElements chunks:', chunks.length);

  try {
    const audioBufs = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let success = false;

      // 1. Try StreamElements (Primary - highly stable)
      try {
        const url = `https://api.streamelements.com/kappa/v2/speech?voice=${seVoice}&text=${encodeURIComponent(chunk)}`;
        const r = await fetch(url);
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 100) {
            audioBufs.push(buf);
            success = true;
            console.log(`[TTS] chunk ${i+1} OK via StreamElements`);
          }
        }
      } catch(e) { console.warn('[TTS] SE failed chunk', i+1, e.message); }

      // 2. Fallback to old TikTok proxy if SE fails
      if (!success) {
         try {
            const tkVoice = { 'en-us-m':'en_us_006', 'en-us-f':'en_us_001', 'en-gb-m':'en_uk_001', 'en-gb-f':'en_uk_003' }[voice] || 'en_us_006';
            const r = await fetch('https://tiktok-tts.weilnet.workers.dev/api/generation', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: chunk, voice: tkVoice })
            });
            const data = await r.json();
            if (data.success && data.data) {
               audioBufs.push(Buffer.from(data.data, 'base64'));
               success = true;
               console.log(`[TTS] chunk ${i+1} OK via TikTok Fallback`);
            }
         } catch(e) { console.warn('[TTS] TK fallback failed chunk', i+1); }
      }

      if (!success) console.error(`[TTS] chunk ${i+1} PERMANENTLY FAILED`);
    }

    if (audioBufs.length === 0) {
      return res.status(500).json({ error: 'All TTS providers failed' });
    }

    const finalAudio = Buffer.concat(audioBufs);
    res.set('Content-Type', 'audio/mpeg');
    res.send(finalAudio);
  } catch (err) {
    console.error('[TTS] fatal error:', err);
    res.status(500).json({ error: 'TTS generation crashed: ' + err.message });
  }
});

    app.get('/eleven-test', async (req, res) => {
  const key = process.env.ELEVENLABS_KEY;
  if (!key) return res.json({ error: 'No key found' });
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB', {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello, VideoKit is working!', model_id: 'eleven_turbo_v2_5' })
    });
    if (r.ok) {
      res.json({ status: 'OK', working: true, bytes: parseInt(r.headers.get('content-length')||'0') });
    } else {
      const err = await r.json().catch(()=>({}));
      res.json({ status: r.status, working: false, error: err });
    }
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ── Video URL Analyzer ────────────────────────────────────────
app.post('/analyze-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  let platform = 'unknown', title = '', description = '', transcript = '';

  // Detect platform
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    platform = 'youtube';
    try {
      // Get basic info via oEmbed
      const videoId = url.match(/(?:v=|youtu\.be\/|shorts\/)([^&?\s\/]+)/)?.[1];
      if (videoId) {
        const oEmbed = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
        const data   = await oEmbed.json();
        title       = data.title || '';

        // Try to get transcript via free API
        try {
          const txRes  = await fetch(`https://yt-transcript-api.vercel.app/transcript?video_id=${videoId}`);
          const txData = await txRes.json();
          if (txData && Array.isArray(txData)) {
            transcript = txData.map(t => t.text).join(' ').slice(0, 2000);
          }
        } catch(e) { console.log('[Transcript] failed:', e.message); }
      }
    } catch(e) { console.log('[YouTube oEmbed] failed:', e.message); }

  } else if (url.includes('instagram.com')) {
    platform = 'instagram';
    // Instagram blocks all external fetching - return platform info only
  } else if (url.includes('tiktok.com')) {
    platform = 'tiktok';
  } else if (url.includes('facebook.com') || url.includes('fb.watch')) {
    platform = 'facebook';
  }

  // Use Groq to analyze what we have and generate similar script blueprint
  const keys = [process.env.GROQ_KEY, process.env.GROQ_KEY2, process.env.GROQ_KEY3].filter(Boolean);
  const key  = keys[0];

  if (title || transcript) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `Analyze this video and extract key information to help create similar content.
Title: ${title}
Transcript excerpt: ${transcript.slice(0, 1000)}

Return a JSON object with:
- topic (main topic in 1 sentence)
- style (educational/motivational/storytelling/listicle/news/documentary)
- tone (professional/casual/energetic/calm)
- hook_style (how the video starts - question/statement/shocking fact/story)
- key_points (array of 3-5 main points covered)
- suggested_idea (a fresh idea for a similar video, reworded to be original)

No markdown. Just JSON.`
          }]
        })
      });
      const groqData = await groqRes.json();
      const raw      = groqData.choices[0].message.content.trim().replace(/```json|```/g,'').trim();
      const analysis = JSON.parse(raw);

      return res.json({ platform, title, transcript: transcript.slice(0,500), analysis, success: true });
    } catch(e) {
      console.log('[Groq analysis] failed:', e.message);
    }
  }

  // Return what we have even without full analysis
  res.json({ platform, title, transcript: '', analysis: null, success: false,
    message: platform === 'youtube' ? 'Could not fetch video details' :
             `${platform} links cannot be fetched automatically. Please paste the video caption or description below.`
  });
});

// Image search for slideshow mode
app.get('/images', async (req, res) => {
  const { q, duration } = req.query;
  const key = process.env.PIXABAY_KEY;
  if (!key) return res.status(500).json({ error: 'No key' });
  const secs = parseInt(duration)||60;
  const perPage = secs<=60?6:secs<=300?10:15;
  try {
    const r = await fetch(`https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(q)}&per_page=${perPage}&image_type=photo&safesearch=true&orientation=vertical`);
    const data = await r.json();
    res.json({ hits: data.hits||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Music search
app.get('/music', async (req, res) => {
  const key = process.env.PIXABAY_KEY;
  const { mood } = req.query;
  try {
    const r = await fetch(`https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(mood||'background')}&media_type=music&per_page=10`);
    const data = await r.json();
    res.json({ hits: data.hits||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
