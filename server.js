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

function extractUrls(output) {
  if (!output) return [];
  const arr = Array.isArray(output) ? output : [output];
  return arr.map(o => typeof o === 'string' ? o : (o.url ? o.url() : String(o)));
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

// base64 写入临时文件
function b64toFile(b64, ext) {
  const matches = b64.match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error('无效的base64');
  const buffer = Buffer.from(matches[2], 'base64');
  const filePath = path.join(TMP, `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// 文件转base64
function fileToB64(filePath) {
  const ext = path.extname(filePath).slice(1);
  const mime = ext === 'mp4' ? 'video/mp4' : ext === 'mp3' ? 'audio/mp3' : ext === 'wav' ? 'audio/wav' : 'application/octet-stream';
  const buffer = fs.readFileSync(filePath);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

// URL下载到文件
async function urlToFile(url, ext) {
  const r = await fetch(url);
  const buffer = Buffer.from(await r.arrayBuffer());
  const filePath = path.join(TMP, `${Date.now()}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// 检查 FFmpeg
function checkFFmpeg() {
  try { execSync('ffmpeg -version', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// ===== 图片生成 =====
app.post('/api/generate', async (req, res) => {
  try {
    const output = await replicate.run('black-forest-labs/flux-schnell', { input: req.body.input });
    res.json({ status: 'succeeded', output: extractUrls(output) });
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
    res.json({ status: 'succeeded', output: extractUrls(output) });
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
      input: { prompt, duration: duration || 6, ratio: ratio || '16:9', resolution: '1080p', prompt_optimizer: true }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 图生视频 =====
app.post('/api/img2video', async (req, res) => {
  try {
    const { image, prompt, duration } = req.body;
    const imgUrl = await b64toUrl(image);
    const output = await replicate.run('minimax/video-01', {
      input: { prompt: prompt || 'smooth cinematic motion', first_frame_image: imgUrl, duration: duration || 6, ratio: '16:9', resolution: '1080p', prompt_optimizer: true }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 多图生视频 =====
app.post('/api/imgs2video', async (req, res) => {
  try {
    const { images, prompt, duration_per_image } = req.body;
    if (!images || images.length < 2) throw new Error('至少需要2张图片');
    const videoUrls = [];
    for (let i = 0; i < images.length; i++) {
      const imgUrl = await b64toUrl(images[i]);
      const output = await replicate.run('minimax/video-01', {
        input: { prompt: prompt || 'smooth cinematic motion', first_frame_image: imgUrl, duration: duration_per_image || 3, ratio: '16:9', resolution: '720p', prompt_optimizer: true }
      });
      const urls = extractUrls(output);
      if (urls.length > 0) videoUrls.push(urls[0]);
    }
    res.json({ status: 'succeeded', output: videoUrls });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== TTS 语音生成 =====
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
    res.json({ status: 'succeeded', audio_url: audioUrl });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 口型同步 =====
app.post('/api/lipsync', async (req, res) => {
  try {
    const { image, audio_url } = req.body;
    const imgUrl = await b64toUrl(image);
    const output = await replicate.run(
      'devxpy/easy-wav2lip:84e5c1b5a80ad8f5b9b9a0c4c46d11085e8a36da97a5e11b9f7ff6c5a39879d',
      { input: { face: imgUrl, audio: audio_url, pads: '0 10 0 0', smooth: true, resize_factor: 1 } }
    );
    res.json({ status: 'succeeded', output: extractUrls(output) });
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
    const output = await replicate.run(
      'devxpy/easy-wav2lip:84e5c1b5a80ad8f5b9b9a0c4c46d11085e8a36da97a5e11b9f7ff6c5a39879d',
      { input: { face: imgUrl, audio: audioUrl, pads: '0 10 0 0', smooth: true, resize_factor: 1 } }
    );
    res.json({ status: 'succeeded', output: extractUrls(output), audio_url: audioUrl });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 核心：FFmpeg 视频混音合并 =====
app.post('/api/mix-audio', async (req, res) => {
  const files = [];
  try {
    const { video_b64, narration_url, music_url, music_b64, narration_volume, music_volume, original_volume, start_time, fade_in, fade_out } = req.body;

    if (!checkFFmpeg()) throw new Error('FFmpeg 未安装，请联系管理员');
    if (!video_b64) throw new Error('请提供视频');

    // 写入视频文件
    const videoFile = b64toFile(video_b64, 'mp4');
    files.push(videoFile);

    const narVol = narration_volume || 1.0;
    const bgVol = music_volume || 0.3;
    const origVol = original_volume || 0.0;
    const outputFile = path.join(TMP, `mixed_${Date.now()}.mp4`);
    files.push(outputFile);

    let ffmpegCmd = '';

    if (narration_url && (music_url || music_b64)) {
      // 有旁白 + 背景音乐
      const narFile = await urlToFile(narration_url, 'wav');
      files.push(narFile);
      let bgFile;
      if (music_b64) { bgFile = b64toFile(music_b64, 'mp3'); }
      else { bgFile = await urlToFile(music_url, 'mp3'); }
      files.push(bgFile);

      const fadeIn = fade_in ? `,afade=t=in:st=0:d=1` : '';
      const fadeOut = fade_out ? `,afade=t=out:st=5:d=1` : '';

      ffmpegCmd = `ffmpeg -y -i "${videoFile}" -i "${narFile}" -i "${bgFile}" -filter_complex "[0:a]volume=${origVol}[orig];[1:a]volume=${narVol}[nar];[2:a]volume=${bgVol},aloop=loop=-1:size=2e+09${fadeIn}${fadeOut}[bg];[orig][nar][bg]amix=inputs=3:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${outputFile}"`;

    } else if (narration_url) {
      // 只有旁白
      const narFile = await urlToFile(narration_url, 'wav');
      files.push(narFile);
      ffmpegCmd = `ffmpeg -y -i "${videoFile}" -i "${narFile}" -filter_complex "[0:a]volume=${origVol}[orig];[1:a]volume=${narVol}[nar];[orig][nar]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${outputFile}"`;

    } else if (music_url || music_b64) {
      // 只有背景音乐
      let bgFile;
      if (music_b64) { bgFile = b64toFile(music_b64, 'mp3'); }
      else { bgFile = await urlToFile(music_url, 'mp3'); }
      files.push(bgFile);
      const fadeIn = fade_in ? `,afade=t=in:st=0:d=1` : '';
      const fadeOut = fade_out ? `,afade=t=out:st=5:d=1` : '';
      ffmpegCmd = `ffmpeg -y -i "${videoFile}" -i "${bgFile}" -filter_complex "[0:a]volume=${origVol}[orig];[1:a]volume=${bgVol},aloop=loop=-1:size=2e+09${fadeIn}${fadeOut}[bg];[orig][bg]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${outputFile}"`;

    } else {
      throw new Error('请至少提供旁白或背景音乐');
    }

    execSync(ffmpegCmd, { timeout: 120000 });
    const resultB64 = fileToB64(outputFile);
    res.json({ status: 'succeeded', output: resultB64 });

  } catch(e) {
    res.status(500).json({ detail: e.message });
  } finally {
    files.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
  }
});

// ===== 鼓点检测 =====
app.post('/api/detect-beats', async (req, res) => {
  try {
    const { audio_url, audio_b64 } = req.body;
    let audioFile;
    const files = [];
    if (audio_b64) { audioFile = b64toFile(audio_b64, 'mp3'); files.push(audioFile); }
    else if (audio_url) { audioFile = await urlToFile(audio_url, 'mp3'); files.push(audioFile); }
    else throw new Error('请提供音频');

    if (!checkFFmpeg()) throw new Error('FFmpeg 未安装');

    // 用 FFmpeg 提取音频信息
    const result = execSync(`ffprobe -v quiet -print_format json -show_streams "${audioFile}"`).toString();
    const info = JSON.parse(result);
    const duration = parseFloat(info.streams[0]?.duration || 30);
    const bpm = 120; // 默认120 BPM
    const beatInterval = 60 / bpm;
    const beats = [];
    for (let t = 0; t < duration; t += beatInterval) beats.push(parseFloat(t.toFixed(3)));

    files.forEach(f => { try { fs.unlinkSync(f); } catch {} });
    res.json({ status: 'succeeded', beats, bpm, duration });
  } catch(e) {
    res.status(500).json({ detail: e.message });
  }
});

// ===== 按鼓点剪辑视频 =====
app.post('/api/beat-cut', async (req, res) => {
  const files = [];
  try {
    const { videos_b64, beats, music_b64, music_url, music_volume, narration_url, narration_volume } = req.body;
    if (!videos_b64 || videos_b64.length === 0) throw new Error('请提供视频片段');
    if (!checkFFmpeg()) throw new Error('FFmpeg 未安装');

    // 写入所有视频片段
    const videoFiles = videos_b64.map(b64 => { const f = b64toFile(b64, 'mp4'); files.push(f); return f; });

    // 计算每段时长
    const segDurations = beats ? beats.slice(1).map((b, i) => b - beats[i]) : videoFiles.map(() => 3);

    // 生成 concat 列表
    const listFile = path.join(TMP, `list_${Date.now()}.txt`);
    files.push(listFile);
    const trimFiles = [];

    let listContent = '';
    for (let i = 0; i < videoFiles.length; i++) {
      const dur = segDurations[i % segDurations.length] || 3;
      const trimFile = path.join(TMP, `trim_${i}_${Date.now()}.mp4`);
      trimFiles.push(trimFile);
      files.push(trimFile);
      execSync(`ffmpeg -y -i "${videoFiles[i]}" -t ${dur} -c:v libx264 -an "${trimFile}"`, { timeout: 30000 });
      listContent += `file '${trimFile}'\n`;
    }
    fs.writeFileSync(listFile, listContent);

    // 合并视频片段
    const concatFile = path.join(TMP, `concat_${Date.now()}.mp4`);
    files.push(concatFile);
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${concatFile}"`, { timeout: 60000 });

    // 添加音频
    const outputFile = path.join(TMP, `output_${Date.now()}.mp4`);
    files.push(outputFile);

    if (music_b64 || music_url || narration_url) {
      let bgFile;
      if (music_b64) { bgFile = b64toFile(music_b64, 'mp3'); files.push(bgFile); }
      else if (music_url) { bgFile = await urlToFile(music_url, 'mp3'); files.push(bgFile); }

      const bgVol = music_volume || 0.4;
      const narVol = narration_volume || 1.0;

      if (bgFile && narration_url) {
        const narFile = await urlToFile(narration_url, 'wav');
        files.push(narFile);
        execSync(`ffmpeg -y -i "${concatFile}" -i "${bgFile}" -i "${narFile}" -filter_complex "[1:a]volume=${bgVol},aloop=loop=-1:size=2e+09,afade=t=in:st=0:d=1[bg];[2:a]volume=${narVol}[nar];[bg][nar]amix=inputs=2:duration=first[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
      } else if (bgFile) {
        execSync(`ffmpeg -y -i "${concatFile}" -i "${bgFile}" -filter_complex "[1:a]volume=${bgVol},aloop=loop=-1:size=2e+09,afade=t=in:st=0:d=1,afade=t=out:st=25:d=2[bg]" -map 0:v -map "[bg]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
      } else if (narration_url) {
        const narFile = await urlToFile(narration_url, 'wav');
        files.push(narFile);
        execSync(`ffmpeg -y -i "${concatFile}" -i "${narFile}" -filter_complex "[1:a]volume=${narVol}[nar]" -map 0:v -map "[nar]" -c:v copy -c:a aac -shortest "${outputFile}"`, { timeout: 120000 });
      }
    } else {
      fs.copyFileSync(concatFile, outputFile);
    }

    const resultB64 = fileToB64(outputFile);
    res.json({ status: 'succeeded', output: resultB64 });

  } catch(e) {
    res.status(500).json({ detail: e.message });
  } finally {
    files.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
  }
});

// ===== AI 加音乐 =====
app.post('/api/video-music', async (req, res) => {
  try {
    const { video_url, music_prompt } = req.body;
    const vidUrl = await b64toUrl(video_url);
    const output = await replicate.run('zsxkib/mmaudio:4b9f801a1b25a443f2d8d27a3169f4d73f0a4327e2374580fde35cde1e3e77e4', {
      input: { video: vidUrl, prompt: music_prompt || 'cinematic background music', duration: 8, num_steps: 25, cfg_strength: 4.5 }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
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
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== AI 剪辑 =====
app.post('/api/ai-edit', async (req, res) => {
  try {
    const { edit_prompt } = req.body;
    const output = await replicate.run('minimax/video-01', {
      input: { prompt: edit_prompt, duration: 6, ratio: '16:9', resolution: '1080p', prompt_optimizer: true }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== FFmpeg 状态检查 =====
app.get('/api/system-check', (req, res) => {
  const ffmpeg = checkFFmpeg();
  let ffmpegVersion = '';
  if (ffmpeg) {
    try { ffmpegVersion = execSync('ffmpeg -version').toString().split('\n')[0]; } catch {}
  }
  res.json({ ffmpeg, ffmpegVersion, tmpDir: TMP });
});

app.listen(3099, () => console.log('OK: http://localhost:3099'));
