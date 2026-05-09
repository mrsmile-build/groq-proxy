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

app.post('/tts-voicerss', async (req, res) => {
  const { text, voice } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text' });

  const safeText = text.slice(0, 300);

  // TikTok TTS - free, no key, real male/female voices
  const voiceMap = {
    'en-us-m':    'en_us_006',
    'en-us-f':    'en_us_001',
    'en-gb-m':    'en_uk_001',
    'en-gb-f':    'en_uk_003',
    'en-au-m':    'en_au_002',
    'en-au-f':    'en_au_002',
    'en-news-m':  'en_us_007',
    'en-story-f': 'en_us_002',
    'fr-m':       'fr_003',
    'de-m':       'de_002',
    'es-m':       'es_002',
    'pt-m':       'pt_002'
  };

  const tikVoice = voiceMap[voice] || 'en_us_006';

  try {
    const r = await fetch('https://tiktok-tts.weilnet.workers.dev/api/generation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: safeText, voice: tikVoice })
    });
    const data = await r.json();
    if (data.success && data.data) {
      const buf = Buffer.from(data.data, 'base64');
      res.set('Content-Type', 'audio/mpeg');
      res.set('X-TTS-Source', 'tiktok');
      return res.send(buf);
    }
  } catch(e) { console.warn('[TTS] TikTok failed:', e.message); }

  // Fallback: Web Speech signal
  res.status(503).json({
    error: 'server_tts_unavailable', fallback: 'webspeech',
    text: safeText, lang: 'en-US',
    male: !['en-us-f','en-gb-f','en-au-f','en-story-f'].includes(voice)
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


// ── Burn text overlay onto video ─────────────────────────────
// Downloads video, burns subtitle text, returns new MP4
app.post('/overlay', async (req, res) => {
  const { videoUrl, text, position } = req.body;
  if (!videoUrl || !text) return res.status(400).json({ error: 'Missing videoUrl or text' });

  try {
    const tmpDir   = tmp.dirSync({ unsafeCleanup: true });
    const inFile   = `${tmpDir.name}/input.mp4`;
    const outFile  = `${tmpDir.name}/output.mp4`;

    await downloadFile(videoUrl, inFile);

    // Clean text for ffmpeg - remove special chars
    const safeText = text.replace(/[':]/g, ' ').slice(0, 120);

    const isTitle = position === 'title';
    const yPos = isTitle ? '(h-text_h)/2' : position === 'top' ? '50' : position === 'center' ? '(h-text_h)/2' : '(h-text_h-40)';
    const fontSize = isTitle ? '42' : '28';
    const boxColor = isTitle ? 'black@0.7' : 'black@0.4';
    const boxBorder = isTitle ? '20' : '8';

    await new Promise((resolve, reject) => {
      ffmpeg(inFile)
        .videoFilters([{
          filter: 'drawtext',
          options: {
            text:        safeText,
            fontsize:    fontSize,
            fontcolor:   'white',
            x:           '(w-text_w)/2',
            y:           yPos,
            shadowcolor: 'black',
            shadowx:     '3',
            shadowy:     '3',
            box:         '1',
            boxcolor:    boxColor,
            boxborderw:  boxBorder,
            line_spacing: '10'
          }
        }])
        .outputOptions(['-c:a', 'copy'])
        .output(outFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename="scene-overlay.mp4"');
    fs.createReadStream(outFile).pipe(res);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Merge videos with text overlays ──────────────────────────
app.post('/merge-overlay', async (req, res) => {
  const { scenes } = req.body;
  // scenes = [{videoUrl, text}, ...]
  if (!scenes || !scenes.length) return res.status(400).json({ error: 'No scenes' });

  try {
    const tmpDir = tmp.dirSync({ unsafeCleanup: true });
    const processedFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      const { videoUrl, text } = scenes[i];
      const inFile  = `${tmpDir.name}/in${i}.mp4`;
      const outFile = `${tmpDir.name}/out${i}.mp4`;

      await downloadFile(videoUrl, inFile);

      if (text && text.trim()) {
        const safeText = text.replace(/[':]/g, ' ').slice(0, 120);
        await new Promise((resolve, reject) => {
          ffmpeg(inFile)
            .videoFilters([{
              filter: 'drawtext',
              options: {
                text: safeText, fontsize: '28', fontcolor: 'white',
                x: '(w-text_w)/2', y: '(h-text_h-40)',
                shadowcolor: 'black', shadowx: '2', shadowy: '2',
                box: '1', boxcolor: 'black@0.4', boxborderw: '8'
              }
            }])
            .outputOptions(['-c:a', 'copy'])
            .output(outFile)
            .on('end', resolve).on('error', reject).run();
        });
        processedFiles.push(outFile);
      } else {
        processedFiles.push(inFile);
      }
    }

    // Now merge all processed files
    const listFile   = `${tmpDir.name}/list.txt`;
    const finalFile  = `${tmpDir.name}/final.mp4`;
    fs.writeFileSync(listFile, processedFiles.map(f => `file '${f}'`).join('\n'));

    await new Promise((resolve, reject) => {
      ffmpeg().input(listFile)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c:v','libx264','-crf','28','-preset','fast','-c:a','aac','-b:a','96k'])
        .output(finalFile)
        .on('end', resolve).on('error', reject).run();
    });

    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename="videokit-final.mp4"');
    fs.createReadStream(finalFile).pipe(res);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});


// HasData trending topics endpoint
app.get('/trending', async (req, res) => {
  const { q } = req.query;
  const key = process.env.HASDATA_KEY;
  try {
    const response = await fetch(
      `https://api.hasdata.com/scrape/google/serp?q=${encodeURIComponent(q)}&gl=us&hl=en`,
      { headers: { 'x-api-key': key } }
    );
    const data = await response.json();
    const results = (data.organicResults || []).slice(0,5).map(r => r.title);
    res.json({ trending: results, query: q });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('VideoKit API running on port', process.env.PORT || 3000);
});

// Keep-alive: ping self every 10 minutes so Render never sleeps
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL + '/').catch(() => {});
    console.log('[Keep-alive] pinged', new Date().toISOString());
  }, 10 * 60 * 1000);
}


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
  const keys = [process.env.GROQ_KEY, process.env.GROQ_KEY2].filter(Boolean);
  const key  = keys[0];

  if (title || transcript) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
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
