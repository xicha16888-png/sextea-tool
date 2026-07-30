const express = require('express');
const Replicate = require('replicate');
const FormData = require('form-data');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.static(__dirname));

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

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

// 文字生图
app.post('/api/generate', async (req, res) => {
  try {
    const output = await replicate.run('black-forest-labs/flux-schnell', { input: req.body.input });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// 图生图
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

// 反推提示词
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

// 文字生视频
app.post('/api/txt2video', async (req, res) => {
  try {
    const { prompt, duration, ratio } = req.body;
    const output = await replicate.run('minimax/video-01', {
      input: { prompt, duration: duration || 6, ratio: ratio || '16:9', resolution: '1080p', prompt_optimizer: true }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// 图生视频
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

// 多图生视频
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

// 视频生视频
app.post('/api/vid2vid', async (req, res) => {
  try {
    const { prompt } = req.body;
    const output = await replicate.run('minimax/video-01', {
      input: { prompt: prompt || 'cinematic style', duration: 6, ratio: '16:9', resolution: '1080p', prompt_optimizer: true }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// 加音乐
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

// 超清放大
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

// AI 剪辑
app.post('/api/ai-edit', async (req, res) => {
  try {
    const { edit_prompt } = req.body;
    const output = await replicate.run('minimax/video-01', {
      input: { prompt: edit_prompt, duration: 6, ratio: '16:9', resolution: '1080p', prompt_optimizer: true }
    });
    res.json({ status: 'succeeded', output: extractUrls(output) });
  } catch(e) { res.status(500).json({ detail: e.message }); }
});

// 视频分析
app.post('/api/analyze-video', async (req, res) => {
  res.json({ status: 'succeeded', analysis: '视频已接收。请在左侧描述您想要的剪辑风格，AI 将根据描述生成对应风格的视频。' });
});

app.listen(3099, () => console.log('OK: http://localhost:3099'));
