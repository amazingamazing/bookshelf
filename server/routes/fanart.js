const router = require('express').Router();
const fetch = require('node-fetch');
const { pool } = require('../db');

router.get('/deviantart', async (req, res) => {
  try {
    const { book_id: rawBookId, query: rawQuery, limit: rawLimit } = req.query;
    const limit = Math.max(1, Math.min(20, Number(rawLimit) || 10));

    let searchText = (rawQuery || '').trim();
    if (rawBookId) {
      const { rows } = await pool.query(`
        SELECT
          b.title,
          a.name AS author_name,
          s.name AS series_name
        FROM books b
        LEFT JOIN authors a ON a.id = b.author_id
        LEFT JOIN series s ON s.id = b.series_id
        WHERE b.id = $1
      `, [rawBookId]);
      if (!rows[0]) return res.status(404).json({ error: 'Book not found' });
      const b = rows[0];
      const pieces = [b.title, b.series_name, b.author_name, 'fan art'];
      searchText = pieces.filter(Boolean).join(' ');
    }

    if (!searchText) {
      return res.status(400).json({ error: 'Provide book_id or query' });
    }

    const rssUrl = `https://backend.deviantart.com/rss.xml?q=${encodeURIComponent(searchText)}&type=deviation`;
    const feedRes = await fetch(rssUrl);
    if (!feedRes.ok) {
      return res.status(502).json({ error: `DeviantArt RSS lookup failed (${feedRes.status})` });
    }

    const xml = await feedRes.text();
    const items = parseRssItems(xml)
      .filter(item => item.title && item.link && item.image_url)
      .slice(0, limit);

    res.json({
      source: 'deviantart_rss',
      query: searchText,
      count: items.length,
      items
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseRssItems(xml) {
  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
  return itemBlocks.map(parseRssItem).filter(Boolean);
}

function parseRssItem(raw) {
  const title = decodeHtml(getTag(raw, 'title'));
  const link = getTag(raw, 'link');
  const creator = decodeHtml(getDcCreator(raw));
  const pubDate = getTag(raw, 'pubDate');
  const imageUrl = getMediaThumbnail(raw) || getMediaContent(raw) || getImageFromDescription(getTag(raw, 'description'));

  if (!title || !link || !imageUrl) return null;
  return {
    title,
    link,
    creator: creator || null,
    published_at: pubDate || null,
    image_url: imageUrl
  };
}

function getTag(raw, tag) {
  const match = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? stripCdata(match[1]).trim() : '';
}

function getDcCreator(raw) {
  const match = raw.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/i);
  return match ? stripCdata(match[1]).trim() : '';
}

function getMediaThumbnail(raw) {
  const match = raw.match(/<media:thumbnail[^>]*url="([^"]+)"/i);
  return match ? match[1] : '';
}

function getMediaContent(raw) {
  const match = raw.match(/<media:content[^>]*url="([^"]+)"/i);
  return match ? match[1] : '';
}

function getImageFromDescription(description) {
  if (!description) return '';
  const match = description.match(/<img[^>]*src="([^"]+)"/i);
  return match ? match[1] : '';
}

function stripCdata(value) {
  return String(value || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

module.exports = router;
