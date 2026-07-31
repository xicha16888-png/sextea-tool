const express = require('express');
const Replicate = require('replicate');
const FormData = require('form-data');
const fetch = require('node-fetch');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '200mb' }));
app.use(express.static(__dirname));

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const TMP = '/tmp/aivideo';
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// ===== 工具函数 =====

function extractUrls(output) {
  if (!output) return [];
  const arr = Array.isArray(output) ? output : [output];
  return arr.map(o => typeof o === 'string' ? o : (o.url ? o.url() : String(o)));
}

// Replicate URL 立刻下载返回 base64（彻底解决下载问题）
async function urlToB64(url) {
  if (!url || url.startsWith('data:')) return url;
  try {
    const r = await fetch(url, { timeout: 120000 });
    if (!r.ok) return url;
    const buffer = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || 'video/mp4';
    return `data:${ct};base64,${buffer.toString('base64')}`;
  } catch(e) { return url; }
}

async function urlsToB64(urls) {
  return Promise.all(urls.map(u => urlToB64(u)));
}

async function b64toUrl(b64) {
  if (!b64 || !b64.startsWith('data:')) return b64;
  const matches = b64.match(/^data:(.+);base64,(.+)$/);
  if (!matches) return b64;
  const mimeType = matches[1];
  const buffer = Buffer.from(matches[2], 'base64');
  const form = new FormData();
  form.append('content', buffer, { contentType: mimeType, filename: 'upload' });
  const r = await fetch('https://api.replicate.com/v1/files', {
    method: 'POST',
    headers: { 'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`, ...form.getHeaders() },
    body: form
  });
  const data = await r.json();
  return data.urls?.source || data.url || b64;
}

function b64toFile(b64, ext) {
  const matches = b64.match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error('无效的base64');
  const buffer = Buffer.from(matches[2], 'base64');
  const filePath = path.join(TMP, `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function fileToB64(filePath) {
  const ext = path.extname(filePath).slice(1);
  const mime = ext === 'mp4' ? 'video/mp4' : ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : 'application/octet-stream';
  const buffer = fs.readFileSync(filePath);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function urlToFile(url, ext) {
  // 支持 base64 和 http URL
  if (url && url.startsWith('data:')) return b64toFile(url, ext);
  const r = await fetch(url);
  const buffer = Buffer.from(await r.arrayBuffer());
  const filePath = path.join(TMP, `${Date.now()}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function checkFFmpeg() {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function cleanFiles(files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
}

// ===== 图片生成 =====
app.post('/api/generate', async (req, res) => {
  try {
    const output = await replicate.run('black-forest-labs/flux-schnell', { input: req.body.input });
    const urls = extractUrls(output);
    const b64s = await urlsToB64(urls);
    res.json({ status: 'succeeded', output: b64s });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 图生图 =====
app.post('/api/img2img', async (req, res) => {
  try {
    const { image, prompt, strength } = req.body;
    const imgUrl = await b64toUrl(image);
    const output = await replicate.run('black-forest-labs/flux-dev', {
      input: { prompt, image: imgUrl, strength: strength || 0.75, num_inference_steps: 28, guidance: 3.5, num_outputs: 1, output_format: 'jpg', output_quality: 95 }
    });
    const urls = extractUrls(output);
    const b64s = await urlsToB64(urls);
    res.json({ status: 'succeeded', output: b64s });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 反推提示词 =====
app.post('/api/interrogate', async (req, res) => {
  try {
    const imgUrl = await b64toUrl(req.body.image);
    const output = await replicate.run(
      'pharmapsychotic/clip-interrogator:8151e1c9f47e696fa316146a2e35812ccf79cfc9eba05b11c7f450155102af70',
      { input: { image: imgUrl, clip_model_name: 'ViT-L-14/openai', mode: 'best' } }
    );
    res.json({ status: 'succeeded', prompt: output });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 文字生视频 =====
app.post('/api/txt2video', async (req, res) => {
  try {
    const { prompt, duration, ratio } = req.body;
    const output = await replicate.run('minimax/video-01', {
      input: { prompt, duration: 6, ratio: ratio || '16:9', resolution: '1080p', prompt_optimizer: true }
    });
    const urls = extractUrls(output);
    const b64s = await urlsToB64(urls);
    res.json({ status: 'succeeded', output: b64s });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 图生视频 =====
app.post('/api/img2video', async (req, res) => {
  try {
    const { image, prompt, duration } = req.body;
    const imgUrl = await b64toUrl(image);
    // MiniMax 只支持 6 秒，强制锁定
    const dur = 6;
    const output = await replicate.run('minimax/video-01', {
      input: { prompt: prompt || 'smooth cinematic motion', first_frame_image: imgUrl, duration: dur, ratio: '16:9', resolution: '1080p', prompt_optimizer: true }
    });
    const urls = extractUrls(output);
    const b64s = await urlsToB64(urls);
    res.json({ status: 'succeeded', output: b64s });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 多图生视频 =====
app.post('/api/imgs2video', async (req, res) => {
  try {
    const { images, prompt, duration_per_image } = req.body;
    if (!images || images.length < 2) throw new Error('至少需要2张图片');
    const results = [];
    for (let i = 0; i < images.length; i++) {
      const imgUrl = await b64toUrl(images[i]);
      const output = await replicate.run('minimax/video-01', {
        input: { prompt: prompt || 'smooth cinematic motion', first_frame_image: imgUrl, duration: 6, ratio: '16:9', resolution: '1080p', prompt_optimizer: true }
      });
      const urls = extractUrls(output);
      if (urls.length > 0) {
        const b64 = await urlToB64(urls[0]);
        results.push(b64);
      }
    }
    res.json({ status: 'succeeded', output: results });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== TTS =====
app.post('/api/tts', async (req, res) => {
  try {
    const { text, language, voice } = req.body;
    let audioUrl;
    if (language === 'zh') {
      const output = await replicate.run(
        'lucataco/xtts-v2:684bc3855b37866c0c65add2ff39c1df5be61233acfa24cf5cf74cd5a7b2b70',
        { input: { text, speaker: voice || 'https://replicate.delivery/pbxt/Jt79w0xsT64R1JsiJ0HERH6UMNOUEf5nqVmE66YqNZ8CDLC/male.wav', language: 'zh-cn', cleanup_voice: true } }
      );
      audioUrl = extractUrls(output)[0];
    } else if (language === 'km') {
      const output = await replicate.run(
        'facebook/mms-tts:3716b043f9feaf1c7d82d56cc33caa8f7bd4f282a84ad40a7b0f87e31c7e91b',
        { input: { text, language: 'khm' } }
      );
      audioUrl = extractUrls(output)[0];
    } else {
      const output = await replicate.run(
        'jaaari/kokoro-82m:f559560eb822dc509045f3921a1921234918b91739db4bf3daab2169b71c7a13',
        { input: { text, voice: voice || 'af_bella', speed: 1.0 } }
      );
      audioUrl = extractUrls(output)[0];
    }
    const b64 = await urlToB64(audioUrl);
    res.json({ status: 'succeeded', audio_url: b64 });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 口型同步 =====
app.post('/api/lipsync', async (req, res) => {
  try {
    const { image, audio_url } = req.body;
    const imgUrl = await b64toUrl(image);
    const audUrl = audio_url.startsWith('data:') ? await b64toUrl(audio_url) : audio_url;
    const output = await replicate.run(
      'devxpy/easy-wav2lip:84e5c1b5a80ad8f5b9b9a0c4c46d11085e8a36da97a5e11b9f7ff6c5a39879d',
      { input: { face: imgUrl, audio: audUrl, pads: '0 10 0 0', smooth: true, resize_factor: 1 } }
    );
    const urls = extractUrls(output);
    const b64s = await urlsToB64(urls);
    res.json({ status: 'succeeded', output: b64s });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 一键说话视频 =====
app.post('/api/talking-video', async (req, res) => {
  try {
    const { image, text, language, voice } = req.body;
    if (!image) throw new Error('请上传人物图片');
    if (!text) throw new Error('请输入台词');
    let audioUrl;
    if (language === 'zh') {
      const output = await replicate.run(
        'lucataco/xtts-v2:684bc3855b37866c0c65add2ff39c1df5be61233acfa24cf5cf74cd5a7b2b70',
        { input: { text, speaker: voice || 'https://replicate.delivery/pbxt/Jt79w0xsT64R1JsiJ0HERH6UMNOUEf5nqVmE66YqNZ8CDLC/male.wav', language: 'zh-cn', cleanup_voice: true } }
      );
      audioUrl = extractUrls(output)[0];
    } else if (language === 'km') {
      const output = await replicate.run(
        'facebook/mms-tts:3716b043f9feaf1c7d82d56cc33caa8f7bd4f282a84ad40a7b0f87e31c7e91b',
        { input: { text, language: 'khm' } }
      );
      audioUrl = extractUrls(output)[0];
    } else {
      const output = await replicate.run(
        'jaaari/kokoro-82m:f559560eb822dc509045f3921a1921234918b91739db4bf3daab2169b71c7a13',
        { input: { text, voice: voice || 'af_bella', speed: 1.0 } }
      );
      audioUrl = extractUrls(output)[0];
    }
    if (!audioUrl) throw new Error('语音生成失败');
    const imgUrl = await b64toUrl(image);
    const audUrl = await b64toUrl(await urlToB64(audioUrl));
    const output = await replicate.run(
      'devxpy/easy-wav2lip:84e5c1b5a80ad8f5b9b9a0c4c46d11085e8a36da97a5e11b9f7ff6c5a39879d',
      { input: { face: imgUrl, audio: audUrl, pads: '0 10 0 0', smooth: true, resize_factor: 1 } }
    );
    const urls = extractUrls(output);
    const b64s = await urlsToB64(urls);
    const audioB64 = await urlToB64(audioUrl);
    res.json({ status: 'succeeded', output: b64s, audio_url: audioB64 });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== AI 加音乐 =====
app.post('/api/video-music', async (req, res) => {
  try {
    const { video_url, music_prompt } = req.body;
    const vidUrl = await b64toUrl(video_url);
    const output = await replicate.run('zsxkib/mmaudio:4b9f801a1b25a443f2d8d27a3169f4d73f0a4327e2374580fde35cde1e3e77e4', {
      input: { video: vidUrl, prompt: music_prompt || 'cinematic background music', duration: 8, num_steps: 25, cfg_strength: 4.5 }
    });
    const urls = extractUrls(output);
    const b64s = await urlsToB64(urls);
    res.json({ status: 'succeeded', output: b64s });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 超清放大 =====
app.post('/api/video-upscale', async (req, res) => {
  try {
    const { video_url } = req.body;
    const vidUrl = await b64toUrl(video_url);
    const output = await replicate.run('fewjative/real-esrgan-video:4dc519a6a27e1bb9497bb44fd9c89f07ddad9b65cfae5c0fd6fb5fc39eeebd11', {
      input: { video_path: vidUrl, scale: 2 }
    });
    const urls = extractUrls(output);
    const b64s = await urlsToB64(urls);
    res.json({ status: 'succeeded', output: b64s });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== FFmpeg 混音合并 =====
app.post('/api/mix-audio', async (req, res) => {
  const files = [];
  try {
    const { video_b64, narration_url, music_url, music_b64, narration_volume, music_volume, original_volume, fade_in, fade_out } = req.body;
    if (!checkFFmpeg()) throw new Error('FFmpeg 未安装');
    if (!video_b64) throw new Error('请提供视频');
    const videoFile = b64toFile(video_b64, 'mp4'); files.push(videoFile);
    const narVol = narration_volume || 1.0;
    const bgVol = music_volume || 0.3;
    const origVol = original_volume || 0.0;
    const outputFile = path.join(TMP, `mixed_${Date.now()}.mp4`); files.push(outputFile);
    const fadeIn = fade_in ? `,afade=t=in:st=0:d=1` : '';
    const fadeOut = fade_out ? `,afade=t=out:st=5:d=1` : '';
    if (narration_url && (music_url || music_b64)) {
      const narFile = await urlToFile(narration_url, 'wav'); files.push(narFile);
      const bgFile = music_b64 ? b64toFile(music_b64, 'mp3') : await urlToFile(music_url, 'mp3'); files.push(bgFile);
      execSync(`ffmpeg -y -i "${videoFile}" -i "${narFile}" -i "${bgFile}" -filter_complex "[0:a]volume=${origVol}[orig];[1:a]volume=${narVol}[nar];[2:a]volume=${bgVol},aloop=loop=-1:size=2e+09${fadeIn}${fadeOut}[bg];[orig][nar][bg]amix=inputs=3:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
    } else if (narration_url) {
      const narFile = await urlToFile(narration_url, 'wav'); files.push(narFile);
      execSync(`ffmpeg -y -i "${videoFile}" -i "${narFile}" -filter_complex "[0:a]volume=${origVol}[orig];[1:a]volume=${narVol}[nar];[orig][nar]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
    } else if (music_url || music_b64) {
      const bgFile = music_b64 ? b64toFile(music_b64, 'mp3') : await urlToFile(music_url, 'mp3'); files.push(bgFile);
      execSync(`ffmpeg -y -i "${videoFile}" -i "${bgFile}" -filter_complex "[0:a]volume=${origVol}[orig];[1:a]volume=${bgVol},aloop=loop=-1:size=2e+09${fadeIn}${fadeOut}[bg];[orig][bg]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
    } else { throw new Error('请至少提供旁白或背景音乐'); }
    res.json({ status: 'succeeded', output: fileToB64(outputFile) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
  finally { cleanFiles(files); }
});

// ===== 视频拼接合并 =====
app.post('/api/concat-videos', async (req, res) => {
  const files = [];
  try {
    const { videos_b64, narration_url, music_url, music_b64, music_volume, narration_volume, original_volume } = req.body;
    if (!videos_b64 || videos_b64.length < 2) throw new Error('请至少上传2段视频');
    if (!checkFFmpeg()) throw new Error('FFmpeg 未安装');
    const videoFiles = [];
    for (let i = 0; i < videos_b64.length; i++) {
      const f = b64toFile(videos_b64[i], 'mp4'); files.push(f);
      const reencoded = path.join(TMP, `re_${i}_${Date.now()}.mp4`); files.push(reencoded);
      execSync(`ffmpeg -y -i "${f}" -c:v libx264 -preset fast -crf 23 -an "${reencoded}"`, { timeout: 60000 });
      videoFiles.push(reencoded);
    }
    const listFile = path.join(TMP, `list_${Date.now()}.txt`); files.push(listFile);
    fs.writeFileSync(listFile, videoFiles.map(f => `file '${f}'`).join('\n'));
    const concatFile = path.join(TMP, `concat_${Date.now()}.mp4`); files.push(concatFile);
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${concatFile}"`, { timeout: 120000 });
    const outputFile = path.join(TMP, `output_${Date.now()}.mp4`); files.push(outputFile);
    const narVol = narration_volume || 1.0;
    const bgVol = music_volume || 0.3;
    const origVol = original_volume || 0.0;
    const hasBg = music_url || music_b64;
    const hasNar = narration_url;
    if (hasBg && hasNar) {
      const bgFile = music_b64 ? b64toFile(music_b64, 'mp3') : await urlToFile(music_url, 'mp3'); files.push(bgFile);
      const narFile = await urlToFile(narration_url, 'wav'); files.push(narFile);
      execSync(`ffmpeg -y -i "${concatFile}" -i "${bgFile}" -i "${narFile}" -filter_complex "[0:a]volume=${origVol}[orig];[1:a]volume=${bgVol},aloop=loop=-1:size=2e+09,afade=t=in:st=0:d=1,afade=t=out:st=25:d=2[bg];[2:a]volume=${narVol}[nar];[orig][bg][nar]amix=inputs=3:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
    } else if (hasBg) {
      const bgFile = music_b64 ? b64toFile(music_b64, 'mp3') : await urlToFile(music_url, 'mp3'); files.push(bgFile);
      execSync(`ffmpeg -y -i "${concatFile}" -i "${bgFile}" -filter_complex "[0:a]volume=${origVol}[orig];[1:a]volume=${bgVol},aloop=loop=-1:size=2e+09,afade=t=in:st=0:d=1,afade=t=out:st=25:d=2[bg];[orig][bg]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
    } else if (hasNar) {
      const narFile = await urlToFile(narration_url, 'wav'); files.push(narFile);
      execSync(`ffmpeg -y -i "${concatFile}" -i "${narFile}" -filter_complex "[1:a]volume=${narVol}[nar]" -map 0:v -map "[nar]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
    } else {
      fs.copyFileSync(concatFile, outputFile);
    }
    res.json({ status: 'succeeded', output: fileToB64(outputFile), segments: videos_b64.length });
  } catch(e) { res.status(500).json({ detail: e.message }); }
  finally { cleanFiles(files); }
});

// ===== 鼓点检测 =====
app.post('/api/detect-beats', async (req, res) => {
  const files = [];
  try {
    const { audio_url, audio_b64 } = req.body;
    if (!checkFFmpeg()) throw new Error('FFmpeg 未安装');
    const audioFile = audio_b64 ? b64toFile(audio_b64, 'mp3') : await urlToFile(audio_url, 'mp3');
    files.push(audioFile);
    const result = execSync(`ffprobe -v quiet -print_format json -show_streams "${audioFile}"`).toString();
    const info = JSON.parse(result);
    const duration = parseFloat(info.streams[0]?.duration || 30);
    const bpm = 120;
    const beatInterval = 60 / bpm;
    const beats = [];
    for (let t = 0; t < duration; t += beatInterval) beats.push(parseFloat(t.toFixed(3)));
    res.json({ status: 'succeeded', beats, bpm, duration });
  } catch(e) { res.status(500).json({ detail: e.message }); }
  finally { cleanFiles(files); }
});

// ===== 按鼓点剪辑 =====
app.post('/api/beat-cut', async (req, res) => {
  const files = [];
  try {
    const { videos_b64, beats, music_b64, music_url, music_volume, narration_url, narration_volume } = req.body;
    if (!videos_b64 || videos_b64.length === 0) throw new Error('请提供视频片段');
    if (!checkFFmpeg()) throw new Error('FFmpeg 未安装');
    const videoFiles = videos_b64.map(b64 => { const f = b64toFile(b64, 'mp4'); files.push(f); return f; });
    const segDurations = beats ? beats.slice(1).map((b, i) => b - beats[i]) : videoFiles.map(() => 6);
    const listFile = path.join(TMP, `list_${Date.now()}.txt`); files.push(listFile);
    let listContent = '';
    for (let i = 0; i < videoFiles.length; i++) {
      const dur = segDurations[i % segDurations.length] || 6;
      const trimFile = path.join(TMP, `trim_${i}_${Date.now()}.mp4`); files.push(trimFile);
      execSync(`ffmpeg -y -i "${videoFiles[i]}" -t ${dur} -c:v libx264 -an "${trimFile}"`, { timeout: 30000 });
      listContent += `file '${trimFile}'\n`;
    }
    fs.writeFileSync(listFile, listContent);
    const concatFile = path.join(TMP, `concat_${Date.now()}.mp4`); files.push(concatFile);
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${concatFile}"`, { timeout: 60000 });
    const outputFile = path.join(TMP, `output_${Date.now()}.mp4`); files.push(outputFile);
    const bgVol = music_volume || 0.4;
    const narVol = narration_volume || 1.0;
    const hasBg = music_b64 || music_url;
    const hasNar = narration_url;
    if (hasBg && hasNar) {
      const bgFile = music_b64 ? b64toFile(music_b64, 'mp3') : await urlToFile(music_url, 'mp3'); files.push(bgFile);
      const narFile = await urlToFile(narration_url, 'wav'); files.push(narFile);
      execSync(`ffmpeg -y -i "${concatFile}" -i "${bgFile}" -i "${narFile}" -filter_complex "[1:a]volume=${bgVol},aloop=loop=-1:size=2e+09,afade=t=in:st=0:d=1[bg];[2:a]volume=${narVol}[nar];[bg][nar]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
    } else if (hasBg) {
      const bgFile = music_b64 ? b64toFile(music_b64, 'mp3') : await urlToFile(music_url, 'mp3'); files.push(bgFile);
      execSync(`ffmpeg -y -i "${concatFile}" -i "${bgFile}" -filter_complex "[1:a]volume=${bgVol},aloop=loop=-1:size=2e+09,afade=t=in:st=0:d=1,afade=t=out:st=25:d=2[bg]" -map 0:v -map "[bg]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
    } else if (hasNar) {
      const narFile = await urlToFile(narration_url, 'wav'); files.push(narFile);
      execSync(`ffmpeg -y -i "${concatFile}" -i "${narFile}" -filter_complex "[1:a]volume=${narVol}[nar]" -map 0:v -map "[nar]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
    } else {
      fs.copyFileSync(concatFile, outputFile);
    }
    res.json({ status: 'succeeded', output: fileToB64(outputFile) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
  finally { cleanFiles(files); }
});

// ===== 系统检查 =====
app.get('/api/system-check', (req, res) => {
  const ffmpeg = checkFFmpeg();
  let ffmpegVersion = '';
  if (ffmpeg) { try { ffmpegVersion = execSync('ffmpeg -version').toString().split('\n')[0]; } catch {} }
  res.json({ ffmpeg, ffmpegVersion, tmpDir: TMP });
});

app.listen(3099, () => console.log('OK: http://localhost:3099'));
