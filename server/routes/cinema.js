const router = require('express').Router();
const fetch = require('node-fetch');
const { pool } = require('../db');

router.get('/series-images/:seriesId', async (req, res) => {
  try {
    const seriesId = Number(req.params.seriesId);
    if (!Number.isFinite(seriesId)) return res.status(400).json({ error: 'Invalid series id' });

    const fanartEnabled = parseBoolean(req.query.fanart_enabled, true);
    const fanartPerCoverMode = normalizeFanartPerCover(req.query.fanart_per_cover);
    const fanartLimit = Math.max(8, Math.min(120, Number(req.query.fanart_limit) || 40));

    const { rows: seriesRows } = await pool.query(`
      SELECT
        s.id,
        s.name,
        s.tier,
        a.name AS author_name
      FROM series s
      LEFT JOIN authors a ON a.id = s.author_id
      WHERE s.id = $1
      LIMIT 1
    `, [seriesId]);
    const series = seriesRows[0];
    if (!series) return res.status(404).json({ error: 'Series not found' });

    const { rows: coverRows } = await pool.query(`
      SELECT
        b.id,
        b.title,
        b.cover_url
      FROM books b
      WHERE b.series_id = $1
        AND b.cover_url IS NOT NULL
        AND b.cover_url <> ''
      ORDER BY b.published_date NULLS LAST, b.series_order NULLS LAST, b.id
    `, [seriesId]);

    const covers = coverRows.map(row => ({
      url: String(row.cover_url).trim(),
      source: 'book_cover',
      kind: 'cover',
      title: row.title || series.name,
      creator: null,
      creator_url: null,
      external_link: null
    })).filter(image => image.url);

    if (!covers.length) {
      return res.json({
        series: {
          id: series.id,
          name: series.name,
          author_name: series.author_name,
          tier: series.tier
        },
        count: 0,
        images: []
      });
    }

    const fanartPool = fanartEnabled
      ? await fetchSeriesFanartViaExistingEndpoint(req, seriesId, fanartLimit)
      : [];
    const images = composeCinemaSequence(covers, fanartPool, fanartPerCoverMode);

    res.json({
      series: {
        id: series.id,
        name: series.name,
        author_name: series.author_name,
        tier: series.tier
      },
      count: images.length,
      images
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function fetchSeriesFanartViaExistingEndpoint(req, seriesId, limit) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) return [];

  const params = new URLSearchParams({
    series_id: String(seriesId),
    limit: String(limit),
    allow_mature: 'false',
    min_edge: '700',
    sort_mode: 'popular',
    time_window: 'all',
    exclude_ai: 'true',
    per_creator_cap: '2'
  });

  const url = `${protocol}://${host}/api/fanart/deviantart?${params.toString()}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const imageUrl = String(item?.image_url || '').trim();
      if (!imageUrl || seen.has(imageUrl)) continue;
      seen.add(imageUrl);
      out.push({
        url: imageUrl,
        source: 'fanart',
        kind: 'fanart',
        title: item.title || null,
        creator: item.creator || null,
        creator_url: deriveDeviantartArtistUrl(item),
        external_link: item.link || null
      });
    }
    return out;
  } catch {
    return [];
  }
}

function composeCinemaSequence(covers, fanartPool, fanartPerCoverMode) {
  const sequence = [];
  let fanartCursor = 0;
  const hasFanart = Array.isArray(fanartPool) && fanartPool.length > 0;

  for (let index = 0; index < covers.length; index += 1) {
    const cover = covers[index];
    sequence.push(cover);

    if (!hasFanart || index === covers.length - 1) continue;

    const targetFanartCount = pickFanartCount(fanartPerCoverMode);
    for (let i = 0; i < targetFanartCount; i += 1) {
      if (fanartCursor >= fanartPool.length) break;
      sequence.push(fanartPool[fanartCursor]);
      fanartCursor += 1;
    }
  }

  return sequence;
}

function pickFanartCount(mode) {
  if (mode === 'random') return randomInt(1, 3);
  return Math.max(0, Math.min(3, Number(mode) || 0));
}

function normalizeFanartPerCover(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'random' || normalized === 'rand') return 'random';
  const asNumber = Number(normalized);
  if (!Number.isFinite(asNumber)) return 'random';
  const rounded = Math.round(asNumber);
  return Math.max(0, Math.min(3, rounded));
}

function deriveDeviantartArtistUrl(item) {
  const creator = String(item?.creator || '').trim();
  if (creator) return `https://www.deviantart.com/${encodeURIComponent(creator)}`;
  const link = String(item?.link || '');
  const subdomainMatch = link.match(/https?:\/\/([a-z0-9-]+)\.deviantart\.com/i);
  if (subdomainMatch && subdomainMatch[1] && subdomainMatch[1].toLowerCase() !== 'www') {
    return `https://${subdomainMatch[1].toLowerCase()}.deviantart.com`;
  }
  const pathMatch = link.match(/https?:\/\/(?:www\.)?deviantart\.com\/([a-z0-9-]+)\//i);
  if (pathMatch && pathMatch[1]) return `https://www.deviantart.com/${pathMatch[1].toLowerCase()}`;
  return null;
}

function parseBoolean(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function randomInt(min, max) {
  const lo = Math.ceil(Number(min) || 0);
  const hi = Math.floor(Number(max) || 0);
  if (hi <= lo) return lo;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

module.exports = router;
