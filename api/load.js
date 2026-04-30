/* api/load.js — Retrieve a saved report from Vercel KV (Upstash REST) */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const id = (req.query && req.query.id) || '';
  if (!id || !/^[A-Za-z0-9_-]{6,16}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid or missing report ID.' });
  }

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: 'KV store not configured on this server.' });
  }

  try {
    const kvRes = await fetch(kvUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + kvToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['GET', 'report:' + id])
    });

    if (!kvRes.ok) {
      return res.status(500).json({ error: 'KV read failed (' + kvRes.status + ')' });
    }

    const data = await kvRes.json();
    const html = data.result || null;

    if (!html) {
      return res.status(404).json({ error: 'Report not found. It may have expired or the link may be invalid.' });
    }

    return res.status(200).json({ html });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load report: ' + err.message });
  }
};
