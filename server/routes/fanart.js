const router = require('express').Router();
const fetch = require('node-fetch');
const { pool } = require('../db');

router.get('/deviantart', async (req, res) => {
  try {
    const {
      book_id: rawBookId,
      series_id: rawSeriesId,
      query: rawQuery,
      limit: rawLimit
    } = req.query;
    const limit = Math.max(1, Math.min(20, Number(rawLimit) || 10));

    let searchText = (rawQuery || '').trim();
    const searchQueries = [];
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
      searchQueries.push(searchText);
    }

    if (rawSeriesId) {
      const { rows } = await pool.query(`
        SELECT
          s.id,
          s.name AS series_name,
          a.name AS author_name,
          (
            SELECT b1.title
            FROM books b1
            WHERE b1.series_id = s.id
            ORDER BY b1.series_order NULLS LAST, b1.id
            LIMIT 1
          ) AS first_book_title
        FROM series s
        LEFT JOIN authors a ON a.id = s.author_id
        WHERE s.id = $1
      `, [rawSeriesId]);
      if (!rows[0]) return res.status(404).json({ error: 'Series not found' });
      const s = rows[0];

      const seriesQuery = [s.series_name, s.author_name, 'fan art'].filter(Boolean).join(' ');
      searchQueries.push(seriesQuery);

      if (s.first_book_title) {
        const bookOneQuery = [s.first_book_title, s.author_name, 'fan art'].filter(Boolean).join(' ');
        searchQueries.push(bookOneQuery);
      }
    }

    if (!searchText) {
      if (!searchQueries.length) return res.status(400).json({ error: 'Provide series_id, book_id, or query' });
    } else {
      searchQueries.push(searchText);
    }

    const dedupedQueries = Array.from(new Set(searchQueries.map(q => q.trim()).filter(Boolean)));
    const merged = [];
    for (const query of dedupedQueries) {
      const itemsForQuery = await searchDeviantArtRss(query, limit);
      merged.push(...itemsForQuery.map(item => ({ ...item, query })));
      if (merged.length >= limit * 3) break;
    }

    const seen = new Set();
    const unique = [];
    for (const item of merged) {
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      unique.push(item);
      if (unique.length >= limit) break;
    }

    const withLiveImages = [];
    for (const item of unique) {
      const ok = await urlLooksLikeImage(item.image_url);
      if (ok) withLiveImages.push(item);
      if (withLiveImages.length >= limit) break;
    }

    res.json({
      source: 'deviantart_rss',
      query: dedupedQueries.join(' || '),
      queries: dedupedQueries,
      count: withLiveImages.length,
      items: withLiveImages
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function searchDeviantArtRss(searchText, limit) {
  const rssUrl = `https://backend.deviantart.com/rss.xml?q=${encodeURIComponent(searchText)}&type=deviation`;
  const feedRes = await fetch(rssUrl);
  if (!feedRes.ok) return [];
  const xml = await feedRes.text();
  return parseRssItems(xml)
    .filter(item => item.title && item.link && item.image_url)
    .slice(0, limit);
}

function parseRssItems(xml) {
  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
  return itemBlocks.map(parseRssItem).filter(Boolean);
}

function parseRssItem(raw) {
  const title = decodeHtml(getTag(raw, 'title'));
  const link = getTag(raw, 'link');
  const creator = decodeHtml(getDcCreator(raw));
  const pubDate = getTag(raw, 'pubDate');
  const imageUrl = getMediaContent(raw) || getImageFromDescription(getTag(raw, 'description')) || getMediaThumbnail(raw);

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

async function urlLooksLikeImage(url) {
  try {
    let res = await fetch(url, { method: 'HEAD' });
    if (!res.ok || res.status === 405) {
      res = await fetch(url, { method: 'GET' });
      if (!res.ok) return false;
    }
    const contentType = res.headers.get('content-type') || '';
    return contentType.includes('image/');
  } catch {
    return false;
  }
}

module.exports = router;
