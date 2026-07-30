const express = require('express');
const Replicate = require('replicate');
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const replicate = new Replicate({
 auth: process.env.REPLICATE_API_TOKEN
});

app.post('/api/generate', async (req, res) => {
  try {
    const output = await replicate.run(
      'black-forest-labs/flux-schnell',
      { input: req.body.input }
    );
    res.json({ status: 'succeeded', output });
  } catch(e) {
    res.status(500).json({ detail: e.message });
  }
});

app.listen(3099, () => console.log('OK: http://localhost:3099'));
