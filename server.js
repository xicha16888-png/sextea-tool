const express = require('express');
const Replicate = require('replicate');
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

// 文字生图
app.post('/api/generate', async (req, res) => {
  try {
    const output = await replicate.run(
      'black-forest-labs/flux-schnell',
      { input: req.body.input }
    );
    const urls = Array.isArray(output)
      ? output.map(o => typeof o === 'string' ? o : o.url ? o.url() : String(o))
      : [typeof output === 'string' ? output : output.url()];
    res.json({ status: 'succeeded', output: urls });
  } catch(e) {
    res.status(500).json({ detail: e.message });
  }
});

// 图生图
app.post('/api/img2img', async (req, res) => {
  try {
    const { image, prompt, strength } = req.body;
    const output = await replicate.run(
      'black-forest-labs/flux-dev',
      {
        input: {
          prompt,
          image,
          strength: strength || 0.75,
          num_inference_steps: 28,
          guidance: 3.5,
          num_outputs: 1,
          output_format: 'jpg',
          output_quality: 95
        }
      }
    );
    const urls = Array.isArray(output)
      ? output.map(o => typeof o === 'string' ? o : o.url ? o.url() : String(o))
      : [typeof output === 'string' ? output : output.url()];
    res.json({ status: 'succeeded', output: urls });
  } catch(e) {
    res.status(500).json({ detail: e.message });
  }
});

// 反推提示词
app.post('/api/interrogate', async (req, res) => {
  try {
    const { image } = req.body;
    const output = await replicate.run(
      'pharmapsychotic/clip-interrogator:8151e1c9f47e696fa316146a2e35812ccf79cfc9eba05b11c7f450155102af70',
      {
        input: {
          image,
          clip_model_name: 'ViT-L-14/openai',
          mode: 'best'
        }
      }
    );
    res.json({ status: 'succeeded', prompt: output });
  } catch(e) {
    res.status(500).json({ detail: e.message });
  }
});

app.listen(3099, () => console.log('OK: http://localhost:3099'));
