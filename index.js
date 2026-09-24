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
  
  const safeText = cleanText.slice(0, 5000);
  
  // ElevenLabs voice map
  const elevenVoiceMap = {
    'en-us-m':    'pNInz6obpgDQGcFmaJgB', // Adam
    'en-us-f':    'EXAVITQu4vr4xnSDxMaL', // Sarah  
    'en-gb-m':    'ErXjobaKcbiMjVbW0cGi', // British male
    'en-gb-f':    'MF3mGyEYCl7XYWbV9V6O', // British female
    'en-au-m':    'pNInz6obpgDQGcFmaJgB', // Adam (reuse)
    'en-au-f':    'EXAVITQu4vr4xnSDxMaL', // Sarah (reuse)
    'en-news-m':  'pNInz6obpgDQGcFmaJgB', // Adam (reuse)
    'en-story-f': 'EXAVITQu4vr4xnSDxMaL'  // Sarah (reuse)
  };
  
  const voiceId = (voice && String(voice).length > 15) ? String(voice) : (elevenVoiceMap[voice] || 'pNInz6obpgDQGcFmaJgB');
  const apiKey = process.env.ELEVENLABS_KEY;
  
  if (!apiKey) {
    return res.status(500).json({ error: 'ELEVENLABS_KEY not set in environment' });
  }
  
  try {
    console.log('[TTS] ElevenLabs request for', voiceId, 'text length:', safeText.length);
    
    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey
      },
      body: JSON.stringify({
        text: safeText,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        }
      })
    });
    
    if (!r.ok) {
      const errText = await r.text();
      console.error('[TTS] ElevenLabs error:', r.status, errText.slice(0, 200));
      const own = process.env.OWN_TTS_URL;
      if (own && (r.status === 429 || r.status === 401 || r.status === 402 || r.status === 403 || r.status >= 500)) {
        try {
          const o = await fetch(own, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: safeText, voice: voice || 'en-us-m' }) });
          if (o.ok) {
            const buf = Buffer.from(await o.arrayBuffer());
            if (buf.length > 100) {
              console.log('[TTS] served by OWN engine, bytes:', buf.length);
              res.set('Content-Type', o.headers.get('content-type') || 'audio/wav');
              return res.send(buf);
            }
          }
        } catch (oe) { console.error('[TTS] own engine failed:', oe.message); }
      }
      return res.status(r.status).json({ error: 'ElevenLabs failed: ' + r.status + ' ' + errText.slice(0, 200) });
    }
    
    const audioBuffer = Buffer.from(await r.arrayBuffer());
    console.log('[TTS] ElevenLabs success, bytes:', audioBuffer.length);
    
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
    
  } catch (err) {
    console.error('[TTS] ElevenLabs fatal error:', err);
    const own = process.env.OWN_TTS_URL;
    if (own) {
      try {
        const o = await fetch(own, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: safeText, voice: voice || 'en-us-m' }) });
        if (o.ok) {
          const buf = Buffer.from(await o.arrayBuffer());
          if (buf.length > 100) {
            console.log('[TTS] served by OWN engine (after crash), bytes:', buf.length);
            res.set('Content-Type', o.headers.get('content-type') || 'audio/wav');
            return res.send(buf);
          }
        }
      } catch (oe) { console.error('[TTS] own engine failed:', oe.message); }
    }
    res.status(500).json({ error: 'ElevenLabs crashed: ' + err.message });
  }
});

// Microsoft Edge TTS implementation (key-free neural voices via signed WebSocket)
async function edgeTTS(text, voice) {
  const WebSocket = require('ws');
  const crypto = require('crypto');
  
  const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
  
  function getHeadersAndURL() {
    const connId = crypto.randomUUID().replace(/-/g, '');
    const ticks = BigInt(Math.floor(Math.floor(Date.now() / 1000) / 300) * 300) * 10000000n;
    const secMsGec = crypto.createHash('sha256').update(String(ticks) + TRUSTED_CLIENT_TOKEN).digest('hex').toUpperCase();
    const secMsGecVersion = '1-130.0.2849.68';
    return {
      url: WSS_URL + '?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN + '&Sec-MS-GEC=' + secMsGec + '&Sec-MS-GEC-Version=' + secMsGecVersion + '&ConnectionId=' + connId,
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
      }
    };
  }

  return new Promise((resolve, reject) => {
    const { url, headers } = getHeadersAndURL();
    const ws = new WebSocket(url, { headers });
    const audioChunks = [];
    let requestId = crypto.randomUUID().replace(/-/g, '');
    
    ws.on('open', () => {
      ws.send(`Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
      ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n<speak version='1.0' xml:lang='en-US'><voice name='${voice}'><prosody rate='0%'>${text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</prosody></voice></speak>`);
    });
    
    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg.includes('Path:audio')) {
        const headerEnd = data.indexOf('\r\n\r\n');
        if (headerEnd !== -1) audioChunks.push(data.slice(headerEnd + 4));
      }
      if (msg.includes('Path:turn.end')) {
        ws.close();
        resolve(Buffer.concat(audioChunks));
      }
    });
    
    ws.on('unexpected-response', (req, res) => { console.warn('[EdgeTTS] handshake HTTP', res.statusCode); try { ws.terminate(); } catch(e) {} reject(new Error('handshake ' + res.statusCode)); });
    ws.on('error', reject);
    ws.on('close', () => { if (audioChunks.length === 0) reject(new Error('No audio received')); });
    
    setTimeout(() => { ws.close(); reject(new Error('Edge TTS timeout')); }, 15000);
  });
}


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
            .input("color=black:720x1280:15")
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
              .videoFilters(["scale=720:1280,fps=24"])
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
  const { scenes, audioBase64, musicUrl } = req.body;
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
          // Text card - solid black video with text
          const cardTextRaw = (scene.text||'').replace(/['":\\]/g,' ').slice(0,150);
          const cardFilters = cardTextRaw ? buildTextLines(cardTextRaw, 22, 42, 'black@0.45', 18, 'center', 1280) : [];
          cardFilters.push(watermarkFilter());
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('text timeout')), 30000);
            const ffc = ffmpeg()
              .input('color=s=720x1280:r=15').inputOptions(['-f','lavfi'])
              .duration(dur);
            if (cardFilters.length) ffc.videoFilters(cardFilters);
            ffc.outputOptions(['-c:v','libx264','-preset','ultrafast','-crf','35','-pix_fmt','yuv420p','-profile:v','baseline','-an'])
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
            const ff = scene.isImage
              ? ffmpeg().input(srcFile).inputOptions(['-loop','1','-t',String(dur)])
              : ffmpeg(srcFile);
            const clipFilters = ['scale=720:1280:force_original_aspect_ratio=decrease','pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black'];
            // Darken the background a touch behind hook frames so bold text pops
            if (scene.isHookFrame && scene.hookText) {
              clipFilters.push({filter:'drawbox',options:{x:0,y:0,w:'iw',h:'ih',color:'black@0.35',t:'fill'}});
            }
            clipFilters.push(watermarkFilter());
            if (scene.isHookFrame && scene.hookText) {
              const hookTextRaw = scene.hookText.toUpperCase().replace(/['":\\]/g,' ').slice(0,80);
              clipFilters.push(...buildTextLines(hookTextRaw, 16, 64, 'black@0.0', 0, 'center', 1280).map(f => Object.assign({}, f, {
                options: Object.assign({}, f.options, {
                  fontcolor: 'yellow',
                  borderw: 6,
                  bordercolor: 'black'
                })
              })));
            } else {
              const clipTextRaw = (scene.text||'').replace(/['":\\]/g,' ').slice(0,120);
              if (clipTextRaw) {
                clipFilters.push(...buildTextLines(clipTextRaw, 22, 34, 'black@0.55', 16, 'bottom', 1280));
              }
            }
            ff.videoFilters(clipFilters)
              .outputOptions(['-c:v','libx264','-preset','ultrafast','-crf','35','-pix_fmt','yuv420p','-profile:v','baseline','-level','3.0','-an','-r','15','-t',String(dur)])
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

      // Add voice (+ optional background music) - NO -shortest, so video
      // is never truncated early if its actual rendered length is a hair
      // longer than the measured voice duration (FFmpeg rounding).
      jobs.get(jobId).progress = 85;
      if (audioBase64) {
        try {
          const audioFile = tmpDir.name + '/voice.mp3';
          fs.writeFileSync(audioFile, Buffer.from(audioBase64,'base64'));

          let musicFile = null;
          if (musicUrl) {
            console.log('[Job '+jobId+'] attempting music download from:', musicUrl);
            try {
              musicFile = tmpDir.name + '/music.mp3';
              await downloadFile(musicUrl, musicFile);
              const musicSize = fs.statSync(musicFile).size;
              console.log('[Job '+jobId+'] music downloaded, size:', musicSize, 'bytes');
              if (musicSize < 1000) {
                console.warn('[Job '+jobId+'] music file too small, likely invalid - skipping');
                musicFile = null;
              }
            } catch(me) {
              console.warn('[Job '+jobId+'] music download FAILED:', me.message);
              musicFile = null;
            }
          } else {
            console.log('[Job '+jobId+'] no musicUrl provided');
          }

          if (musicFile) {
            await new Promise((resolve,reject) => {
              const t = setTimeout(()=>reject(new Error('audio timeout')),40000);
              ffmpeg(mergedFile)
                .input(audioFile)
                .input(musicFile)
                .complexFilter([
                  '[2:a]volume=0.18,aloop=loop=-1:size=2e9[music_low]',
                  '[1:a]volume=1.6[voice_boost]',
                  '[voice_boost][music_low]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]'
                ])
                .outputOptions(['-map','0:v','-map','[aout]','-c:v','copy','-c:a','aac','-movflags','+faststart'])
                .output(finalFile)
                .on('end',()=>{clearTimeout(t);resolve();})
                .on('error',(e)=>{clearTimeout(t);reject(e);})
                .run();
            });
          } else {
            await new Promise((resolve,reject) => {
              const t = setTimeout(()=>reject(new Error('audio timeout')),30000);
              ffmpeg(mergedFile).input(audioFile)
                .outputOptions(['-c:v','copy','-c:a','aac','-movflags','+faststart'])
                .output(finalFile)
                .on('end',()=>{clearTimeout(t);resolve();})
                .on('error',(e)=>{clearTimeout(t);reject(e);})
                .run();
            });
          }
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

app.get('/proxy-image', async (req, res) => {
  const url = req.query.url;
  try {
    const r = await fetch(url);
    const buf = await r.arrayBuffer();
    const ct = r.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', ct);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(buf));
  } catch(e) { res.status(500).send(e.message); }
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


app.post('/clone-voice', async (req, res) => {
  const { name, dataUrl } = req.body || {};
  const key = process.env.ELEVENLABS_KEY;
  if (!key) return res.status(500).json({ error: 'ELEVENLABS_KEY not set' });
  if (!dataUrl) return res.status(400).json({ error: 'No audio sample' });
  try {
    const b64 = String(dataUrl).split(',')[1] || String(dataUrl);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 5000) return res.status(400).json({ error: 'Sample too short - record 1-2 minutes of clear speech' });
    const fd = new FormData();
    fd.append('name', name || 'MyClonedVoice');
    fd.append('description', 'Cloned via VideoKit');
    fd.append('files', new Blob([buf], { type: 'audio/mpeg' }), 'sample.mp3');
    const r = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: fd
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: ((d && d.detail) ? JSON.stringify(d.detail) : ('clone failed ' + r.status)).slice(0, 300) });
    console.log('[CLONE] new voice:', d.voice_id);
    res.json({ voice_id: d.voice_id });
  } catch (e) {
    console.error('[CLONE] fatal:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/voices', async (req, res) => {
  try {
    const key = process.env.ELEVENLABS_KEY;
    if (!key) return res.status(500).json({ error: 'ELEVENLABS_KEY not set' });
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
    if (!r.ok) return res.status(r.status).json({ error: 'voices fetch failed ' + r.status });
    const data = await r.json();
    res.json({ voices: (data.voices || []).map(v => ({ id: v.voice_id, name: v.name, labels: v.labels || {} })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
