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
  // Remove ellipsis that gets spoken literally
  const cleanText = (text||'').replace(/\.\.\.+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text' });

  const safeText = cleanText.slice(0, 6000);

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

  // Split into chunks of 200 chars (TikTok TTS limit per request)
  const words  = safeText.split(' ');
  const chunks = [];
  let cur = '';
  for (const word of words) {
    if ((cur + ' ' + word).trim().length > 200) {
      if (cur.trim()) chunks.push(cur.trim());
      cur = word;
    } else {
      cur = cur ? cur + ' ' + word : word;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());

  console.log('[TTS] chunks:', chunks.length, 'for', safeText.length, 'chars');

  try {
    const audioBufs = [];
    for (const chunk of chunks) {
      const r = await fetch('https://tiktok-tts.weilnet.workers.dev/api/generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: chunk, voice: tikVoice })
      });
      const data = await r.json();
      if (data.success && data.data) {
        audioBufs.push(Buffer.from(data.data, 'base64'));
      }
      // Small delay between chunks
      await new Promise(r => setTimeout(r, 200));
    }
    if (audioBufs.length > 0) {
      const combined = Buffer.concat(audioBufs);
      res.set('Content-Type', 'audio/mpeg');
      res.set('X-TTS-Source', 'tiktok-chunked');
      return res.send(combined);
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
    const clipFiles = [];

    console.log("[Merge] processing", scenes.length, "scenes...");

    // Process sequentially - parallel overloads Render free tier
    for (let i = 0; i < scenes.length; i++) { const scene = scenes[i]; await (async () => {
      const outFile = tmpDir.name + "/clip" + i + ".mp4";
      const dur = scene.duration || 5;

      if (!scene.videoUrl || scene.isTextCard) {
        // Text card - generate from ffmpeg directly (fastest)
        const txt = (scene.text || "Scene " + (i+1)).replace(/['"\:]/g, " ").slice(0, 80);
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("text timeout")), 15000);
          ffmpeg()
            .input("color=black:640x360:15")
            .inputOptions(["-f","lavfi"])
            .duration(dur)
            .videoFilters(["scale=720:1280"])
            .outputOptions(["-c:v","libx264","-preset","ultrafast","-crf","30","-pix_fmt","yuv420p","-profile:v","baseline"])
            .output(outFile)
            .on("end", () => { clearTimeout(t); resolve(); })
            .on("error", (e) => { clearTimeout(t); reject(e); })
            .run();
        });
      } else {
        // Image or video - detect by URL
        const isImage = scene.isImage || /\.(jpg|jpeg|png|webp)/i.test(scene.videoUrl||'');
        const srcFile = tmpDir.name + "/src" + i + (isImage ? ".jpg" : ".mp4");
        await downloadFile(scene.videoUrl, srcFile);

        if (isImage) {
          // Image slideshow - fast
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("img timeout")), 90000);
            ffmpeg()
              .input(srcFile).inputOptions(["-loop","1"])
              .duration(dur)
              .videoFilters(["scale=720:1280"])
              .outputOptions(["-c:v","libx264","-preset","ultrafast","-crf","30","-pix_fmt","yuv420p","-profile:v","baseline","-an"])
              .output(outFile)
              .on("end", () => { clearTimeout(t); resolve(); })
              .on("error", (e) => { clearTimeout(t); reject(e); })
              .run();
          });
        } else {
          // Stock video - just trim and normalize
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("vid timeout")), 30000);
            ffmpeg(srcFile)
              .videoFilters(["scale=640:360,fps=24"])
              .outputOptions(["-c:v","libx264","-preset","ultrafast","-crf","30","-pix_fmt","yuv420p","-profile:v","baseline","-an","-t",String(dur)])
              .output(outFile)
              .on("end", () => { clearTimeout(t); resolve(); })
              .on("error", (e) => { clearTimeout(t); reject(e); })
              .run();
          });
        }
      }

      clipFiles[i] = outFile;
      console.log("[Merge] clip", i+1, "done");
    })(); }

    // Concat all clips (stream copy - all same format now)
    const listFile   = tmpDir.name + "/list.txt";
    const mergedFile = tmpDir.name + "/merged.mp4";
    const finalFile  = tmpDir.name + "/final.mp4";
    fs.writeFileSync(listFile, clipFiles.map(f => "file '" + f + "'").join("\n"));

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("concat timeout")), 30000);
      ffmpeg().input(listFile)
        .inputOptions(["-f","concat","-safe","0"])
        .outputOptions(["-c","copy","-movflags","+faststart"])
        .output(mergedFile)
        .on("end", () => { clearTimeout(t); resolve(); })
        .on("error", (e) => { clearTimeout(t); reject(e); })
        .run();
    });
    console.log("[Merge] concat done, size:", fs.statSync(mergedFile).size);

    // Add voice if provided
    if (audioBase64) {
      try {
        const audioFile = tmpDir.name + "/voice.mp3";
        fs.writeFileSync(audioFile, Buffer.from(audioBase64, "base64"));
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("audio timeout")), 20000);
          ffmpeg(mergedFile).input(audioFile)
            .outputOptions(["-c:v","copy","-c:a","aac","-shortest","-movflags","+faststart"])
            .output(finalFile)
            .on("end", () => { clearTimeout(t); resolve(); })
            .on("error", (e) => { clearTimeout(t); reject(e); })
            .run();
        });
        console.log("[Merge] voice added");
      } catch(ae) {
        console.warn("[Merge] voice failed:", ae.message);
        fs.copyFileSync(mergedFile, finalFile);
      }
    } else {
      fs.copyFileSync(mergedFile, finalFile);
    }

    const fileBuffer = fs.readFileSync(finalFile);
    console.log("[Merge] sending, size:", fileBuffer.length);
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


// ── Async Job System ──────────────────────────────────────────
const jobs = new Map(); // jobId -> {status, progress, file, error}

app.post('/merge-start', async (req, res) => {
  const { scenes, audioBase64 } = req.body;
  if (!scenes || !scenes.length) return res.status(400).json({ error: 'No scenes' });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  jobs.set(jobId, { status: 'processing', progress: 5, file: null, error: null });
  res.json({ jobId });

  // Process in background
  (async () => {
    try {
      const tmpDir = tmp.dirSync({ unsafeCleanup: true });
      const clipFiles = [];
      const total = scenes.length;

      for (let i = 0; i < scenes.length; i++) {
        const scene   = scenes[i];
        const outFile = tmpDir.name + '/clip' + i + '.mp4';
        const dur     = scene.duration || 10;

        if (!scene.videoUrl || scene.isTextCard) {
          const txt = (scene.text||'Scene '+(i+1)).replace(/['"\\:]/g,' ').slice(0,80);
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('text timeout')), 30000);
            ffmpeg()
              .input('color=black:640x360:15').inputOptions(['-f','lavfi'])
              .duration(dur)
              .videoFilters(['scale=640:360'])
              .outputOptions(['-c:v','libx264','-preset','ultrafast','-crf','35','-pix_fmt','yuv420p','-profile:v','baseline'])
              .output(outFile)
              .on('end',()=>{clearTimeout(t);resolve();})
              .on('error',(e)=>{clearTimeout(t);reject(e);})
              .run();
          });
        } else {
          const srcFile = tmpDir.name + '/src' + i + (scene.isImage?'.jpg':'.mp4');
          await downloadFile(scene.videoUrl, srcFile);
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('clip timeout')), 90000);
            const filters = ['scale=640:360'];
            if (scene.text) filters.push({filter:'drawtext',options:{text:(scene.text||'').replace(/[\'"\\:]/g,' ').slice(0,60),fontsize:'16',fontcolor:'white',x:'(w-text_w)/2',y:'h-th-15',box:'1',boxcolor:'black@0.5',boxborderw:'5'}});
            const ff = scene.isImage
              ? ffmpeg().input(srcFile).inputOptions(['-loop','1']).duration(dur)
              : ffmpeg(srcFile);
            ff.videoFilters(filters)
              .outputOptions(['-c:v','libx264','-preset','ultrafast','-crf','35','-pix_fmt','yuv420p','-profile:v','baseline','-an','-r','15','-t',String(dur)])
              .output(outFile)
              .on('end',()=>{clearTimeout(t);resolve();})
              .on('error',(e)=>{clearTimeout(t);reject(e);})
              .run();
          });
        }

        clipFiles[i] = outFile;
        const pct = Math.round(10 + (i+1)/total * 55);
        jobs.get(jobId).progress = pct;
        console.log('[Job '+jobId+'] clip '+(i+1)+'/'+total+' done, '+pct+'%');
      }

      // Concat
      jobs.get(jobId).progress = 70;
      const listFile   = tmpDir.name + '/list.txt';
      const mergedFile = tmpDir.name + '/merged.mp4';
      const finalFile  = tmpDir.name + '/final.mp4';
      fs.writeFileSync(listFile, clipFiles.map(f => "file '"+f+"'").join('\n'));
      await new Promise((resolve,reject) => {
        ffmpeg().input(listFile).inputOptions(['-f','concat','-safe','0'])
          .outputOptions(['-c','copy','-movflags','+faststart'])
          .output(mergedFile)
          .on('end',resolve).on('error',reject).run();
      });

      // Add voice
      jobs.get(jobId).progress = 85;
      if (audioBase64) {
        try {
          const audioFile = tmpDir.name + '/voice.mp3';
          fs.writeFileSync(audioFile, Buffer.from(audioBase64,'base64'));
          await new Promise((resolve,reject) => {
            const t = setTimeout(()=>reject(new Error('audio timeout')),30000);
            ffmpeg(mergedFile).input(audioFile)
              .outputOptions(['-c:v','copy','-c:a','aac','-shortest','-movflags','+faststart'])
              .output(finalFile)
              .on('end',()=>{clearTimeout(t);resolve();})
              .on('error',(e)=>{clearTimeout(t);reject(e);})
              .run();
          });
        } catch(ae) { fs.copyFileSync(mergedFile,finalFile); }
      } else {
        fs.copyFileSync(mergedFile,finalFile);
      }

      const fileBuffer = fs.readFileSync(finalFile);
      tmpDir.removeCallback();
      jobs.get(jobId).status   = 'done';
      jobs.get(jobId).progress = 100;
      jobs.get(jobId).file     = fileBuffer;
      console.log('[Job '+jobId+'] complete, size:', fileBuffer.length);

      // Clean up job after 10 minutes
      setTimeout(() => jobs.delete(jobId), 600000);
    } catch(err) {
      console.error('[Job '+jobId+'] error:', err.message);
      if (jobs.get(jobId)) {
        jobs.get(jobId).status = 'error';
        jobs.get(jobId).error  = err.message;
      }
    }
  })();
});

app.get('/merge-status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'done' && job.file) {
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', 'attachment; filename=videokit-final.mp4');
    res.set('Content-Length', job.file.length);
    const buf = job.file;
    job.file = null; // free memory
    return res.send(buf);
  }
  res.json({ status: job.status, progress: job.progress, error: job.error });
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
  const keys = [process.env.GROQ_KEY, process.env.GROQ_KEY2, process.env.GROQ_KEY3].filter(Boolean);
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
