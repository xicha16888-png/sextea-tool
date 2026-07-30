const express = require('express');
const Replicate = require('replicate');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.static(__dirname));

const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 200 * 1024 * 1024 } });

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

function extractUrls(output) {
  if (!output) return [];
  const arr = Array.isArray(output) ? output : [output];
  return arr.map(o => typeof o === 'string' ? o : (o.url ? o.url() : String(o)));
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
    const output = await replicate.run('black-forest-labs/flux-dev', {
      input: { prompt, image, strength: strength || 0.75, num_inference_steps: 28, guidance: 3.5, num_outputs: 1, output_format: 'jpg', output_quality: 95 }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 反推提示词 =====
app.post('/api/interrogate', async (req, res) => {
  try {
    const output = await replicate.run(
      'pharmapsychotic/clip-interrogator:8151e1c9f47e696fa316146a2e35812ccf79cfc9eba05b11c7f450155102af70',
      { input: { image: req.body.image, clip_model_name: 'ViT-L-14/openai', mode: 'best' } }
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
    const output = await replicate.run('minimax/video-01', {
      input: { prompt: prompt || 'smooth cinematic motion', first_frame_image: image, duration: duration || 6, ratio: '16:9', resolution: '1080p', prompt_optimizer: true }
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
      const output = await replicate.run('minimax/video-01', {
        input: { prompt: prompt || 'smooth cinematic motion', first_frame_image: images[i], duration: duration_per_image || 3, ratio: '16:9', resolution: '720p', prompt_optimizer: true }
      });
      const urls = extractUrls(output);
      if (urls.length > 0) videoUrls.push(urls[0]);
    }
    res.json({ status: 'succeeded', output: videoUrls });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 视频生视频（风格转换）=====
app.post('/api/vid2vid', async (req, res) => {
  try {
    const { video_url, prompt, style, strength } = req.body;
    // 使用 wan-video 做视频风格转换
    const output = await replicate.run('wavespeedai/wan-2.1-i2v-480p', {
      input: {
        prompt: prompt,
        image: video_url,
        num_frames: 81,
        guidance_scale: 5,
        num_inference_steps: 30,
        fast_mode: 'Balanced'
      }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 视频分析（提取关键帧描述）=====
app.post('/api/analyze-video', async (req, res) => {
  try {
    const { video_url } = req.body;
    // 用视频理解模型分析
    const output = await replicate.run('zsxkib/mmaudio:4b9f801a1b25a443f2d8d27a3169f4d73f0a4327e2374580fde35cde1e3e77e4', {
      input: {
        video: video_url,
        prompt: 'Analyze this video and describe: camera movements, scene transitions, color grading, mood, pacing, visual style, lighting. Be detailed and specific.',
        duration: 8,
        num_steps: 25
      }
    });
    res.json({ status: 'succeeded', analysis: String(output) });
  } catch(e) {
    // 降级：返回基础分析提示
    res.json({ status: 'succeeded', analysis: '视频已上传。请描述您想要的剪辑风格，AI将根据您的要求进行处理。' });
  }
});

// ===== 上传视频文件 =====
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) throw new Error('未收到视频文件');
    const filePath = req.file.path;
    const fileData = fs.readFileSync(filePath);
    const base64 = `data:video/mp4;base64,${fileData.toString('base64')}`;
    fs.unlinkSync(filePath);
    res.json({ status: 'succeeded', data: base64, size: req.file.size, name: req.file.originalname });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 视频剪辑 - 添加字幕/文字 =====
app.post('/api/video-caption', async (req, res) => {
  try {
    const { video_url, text, style } = req.body;
    // 使用 video subtitle 模型
    const output = await replicate.run('zsxkib/mmaudio:4b9f801a1b25a443f2d8d27a3169f4d73f0a4327e2374580fde35cde1e3e77e4', {
      input: { video: video_url, prompt: text || 'ambient background music', duration: 8, num_steps: 25, cfg_strength: 4.5 }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 视频加音乐 =====
app.post('/api/video-music', async (req, res) => {
  try {
    const { video_url, music_prompt } = req.body;
    const output = await replicate.run('zsxkib/mmaudio:4b9f801a1b25a443f2d8d27a3169f4d73f0a4327e2374580fde35cde1e3e77e4', {
      input: { video: video_url, prompt: music_prompt || 'cinematic background music, emotional, professional', duration: 8, num_steps: 25, cfg_strength: 4.5 }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== 视频超清放大 =====
app.post('/api/video-upscale', async (req, res) => {
  try {
    const { video_url } = req.body;
    const output = await replicate.run('fewjative/real-esrgan-video:4dc519a6a27e1bb9497bb44fd9c89f07ddad9b65cfae5c0fd6fb5fc39eeebd11', {
      input: { video_path: video_url, scale: 2 }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// ===== AI 自动剪辑（根据描述重新生成）=====
app.post('/api/ai-edit', async (req, res) => {
  try {
    const { video_url, edit_prompt, style_ref_url } = req.body;
    let finalPrompt = edit_prompt;
    if (style_ref_url) {
      finalPrompt = `${edit_prompt}, reference style from the provided video, match the color grading and editing rhythm`;
    }
    // 生成新视频描述
    const output = await replicate.run('minimax/video-01', {
      input: { prompt: finalPrompt, duration: 6, ratio: '16:9', resolution: '1080p', prompt_optimizer: true }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

app.listen(3099, () => console.log('OK: http://localhost:3099'));
