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

// ── ElevenLabs TTS ───────────────────────────────────────────
app.post('/tts-voicerss', async (req, res) => {
  const { text, voice } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });

  const key = process.env.ELEVENLABS_KEY;
  const safeText = text.slice(0, 500);

  const voiceIds = {
    'en-us-matthew': 'pNInz6obpgDQGcFmaJgB',
    'en-us-joey':    'TxGEqnHWrfWFTfGW9XjX',
    'en-us-joanna':  '21m00Tcm4TlvDq8ikWAM',
    'en-us-kendra':  'AZnzlk1XvdvUeBnXmlld',
    'en-us-salli':   'EXAVITQu4vr4xnSDxMaL',
    'en-gb-brian':   'IKne3meq5aSn9XLyUdCD',
    'en-gb-amy':     'XrExE9yKIg1WjnnlVkGX',
    'en-gb-emma':    'ThT5KcBeYPX3keUQqHPh',
    'en-au-russell': 'IKne3meq5aSn9XLyUdCD',
    'en-au-olivia':  'XrExE9yKIg1WjnnlVkGX',
    'en-in-kajal':   '21m00Tcm4TlvDq8ikWAM',
    'fr-remi':       'pNInz6obpgDQGcFmaJgB',
    'fr-lea':        'EXAVITQu4vr4xnSDxMaL',
    'de-daniel':     'TxGEqnHWrfWFTfGW9XjX',
    'de-vicki':      '21m00Tcm4TlvDq8ikWAM',
    'es-sergio':     'VR6AewLTigWG4xSOukaG',
    'es-lucia':      'AZnzlk1XvdvUeBnXmlld',
    'pt-thiago':     'VR6AewLTigWG4xSOukaG',
    'pt-camila':     'EXAVITQu4vr4xnSDxMaL',
    'ar-zayd':       'pNInz6obpgDQGcFmaJgB',
    'ar-hala':       '21m00Tcm4TlvDq8ikWAM'
  };

  const voiceId = voiceIds[voice] || 'pNInz6obpgDQGcFmaJgB';
  const femaleVoices = ['en-us-joanna','en-us-kendra','en-us-salli','en-gb-amy','en-gb-emma','en-au-olivia','en-in-kajal','fr-lea','de-vicki','es-lucia','pt-camila','ar-hala'];

  if (key) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: 'POST', signal: ctrl.signal,
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: safeText,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 }
          })
        }
      );
      clearTimeout(t);
      if (r.ok) {
        const buf = await r.arrayBuffer();
        if (buf.byteLength > 1000) {
          res.set('Content-Type', 'audio/mpeg');
          res.set('Content-Disposition', 'attachment; filename="narration.mp3"');
          res.set('X-TTS-Source', 'elevenlabs');
          return res.send(Buffer.from(buf));
        }
      } else {
        const err = await r.json().catch(() => ({}));
        console.warn('[TTS] ElevenLabs error:', r.status, JSON.stringify(err));
      }
    } catch(e) { console.warn('[TTS] ElevenLabs failed:', e.message); }
  }

  res.status(503).json({
    error: 'server_tts_unavailable', fallback: 'webspeech',
    text: safeText.slice(0, 1000), lang: 'en-US',
    male: !femaleVoices.includes(voice)
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

    // Position: bottom (default), center, top
    const yPos = position === 'top' ? '50' : position === 'center' ? '(h-text_h)/2' : '(h-text_h-40)';

    await new Promise((resolve, reject) => {
      ffmpeg(inFile)
        .videoFilters([{
          filter: 'drawtext',
          options: {
            text:        safeText,
            fontsize:    '28',
            fontcolor:   'white',
            x:           '(w-text_w)/2',
            y:           yPos,
            shadowcolor: 'black',
            shadowx:     '2',
            shadowy:     '2',
            box:         '1',
            boxcolor:    'black@0.4',
            boxborderw:  '8',
            line_spacing: '8'
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
