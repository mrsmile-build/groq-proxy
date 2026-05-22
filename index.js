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
  const { scenes, audioBase64 } = req.body;
  if (!scenes || !scenes.length) return res.status(400).json({ error: 'No scenes' });
  try {
    const tmpDir = tmp.dirSync({ unsafeCleanup: true });
    const videoScenes = scenes.filter(s => s.videoUrl);
    if (!videoScenes.length) return res.status(400).json({ error: 'No video URLs' });

    console.log("[Merge] downloading", videoScenes.length, "clips...");
    await Promise.all(videoScenes.map(async (scene, i) => {
      const dest = tmpDir.name + "/raw" + i + ".mp4";
      await downloadFile(scene.videoUrl, dest);
      videoScenes[i]._file = dest;
      console.log("[Merge] clip", i+1, "ready");
    }));

    const listFile   = tmpDir.name + "/list.txt";
    const mergedFile = tmpDir.name + "/merged.mp4";
    const finalFile  = tmpDir.name + "/final.mp4";

    // Try stream copy first (fast)
    let mergeOk = false;
    fs.writeFileSync(listFile, videoScenes.map(s => "file '" + s._file + "'").join("\n"));
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), 20000);
        ffmpeg().input(listFile)
          .inputOptions(["-f","concat","-safe","0"])
          .outputOptions(["-c","copy","-movflags","+faststart"])
          .output(mergedFile)
          .on("end", () => { clearTimeout(t); resolve(); })
          .on("error", (e) => { clearTimeout(t); reject(e); })
          .run();
      });
      if (fs.statSync(mergedFile).size > 10000) mergeOk = true;
    } catch(e) { console.log("[Merge] stream copy failed:", e.message); }

    // Fallback: normalize then concat
    if (!mergeOk) {
      console.log("[Merge] normalizing clips...");
      const normFiles = [];
      for (let i = 0; i < videoScenes.length; i++) {
        const normDest = tmpDir.name + "/norm" + i + ".mp4";
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("timeout")), 30000);
          ffmpeg(videoScenes[i]._file)
            .videoFilters(["scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,fps=24"])
            .outputOptions(["-c:v","libx264","-profile:v","baseline","-level","3.0","-preset","ultrafast","-crf","30","-pix_fmt","yuv420p","-an","-movflags","+faststart"])
            .output(normDest)
            .on("end", () => { clearTimeout(t); resolve(); })
            .on("error", (e) => { clearTimeout(t); reject(e); })
            .run();
        });
        normFiles.push(normDest);
        console.log("[Merge] normalized", i+1);
      }
      fs.writeFileSync(listFile, normFiles.map(f => "file '" + f + "'").join("\n"));
      await new Promise((resolve, reject) => {
        ffmpeg().input(listFile)
          .inputOptions(["-f","concat","-safe","0"])
          .outputOptions(["-c","copy","-movflags","+faststart"])
          .output(mergedFile)
          .on("end", resolve).on("error", reject).run();
      });
    }

    // Add voice
    if (audioBase64) {
      try {
        const audioFile = tmpDir.name + "/voice.mp3";
        fs.writeFileSync(audioFile, Buffer.from(audioBase64, "base64"));
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("timeout")), 15000);
          ffmpeg(mergedFile).input(audioFile)
            .outputOptions(["-c:v","copy","-c:a","aac","-shortest","-movflags","+faststart"])
            .output(finalFile)
            .on("end", () => { clearTimeout(t); resolve(); })
            .on("error", (e) => { clearTimeout(t); reject(e); })
            .run();
        });
      } catch(ae) { console.warn("[Merge] voice failed:", ae.message); fs.copyFileSync(mergedFile, finalFile); }
    } else {
      fs.copyFileSync(mergedFile, finalFile);
    }

    const fileBuffer = fs.readFileSync(finalFile);
    console.log("[Merge] done, size:", fileBuffer.length);
    tmpDir.removeCallback();
    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", "attachment; filename=videokit-final.mp4");
    res.set("Content-Length", fileBuffer.length);
    res.send(fileBuffer);
  } catch(err) {
    console.error("[Merge] error:", err.message);
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
