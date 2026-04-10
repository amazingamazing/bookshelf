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
    const allowMature = parseBoolean(req.query.allow_mature, false);
    const minEdge = Math.max(200, Math.min(4000, Number(req.query.min_edge) || 700));

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
      const itemsForQuery = await searchDeviantArtRss(query, Math.max(20, limit * 3), { allowMature });
      merged.push(...itemsForQuery.map(item => ({ ...item, query })));
      if (merged.length >= limit * 12) break;
    }

    const seen = new Set();
    const unique = [];
    for (const item of merged) {
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      unique.push(item);
      if (unique.length >= limit * 12) break;
    }

    const withLiveImages = [];
    for (const item of unique) {
      const ok = await urlLooksLikeImage(item.image_url);
      if (!ok) continue;
      if (!passesQualityFloor(item, minEdge)) continue;
      withLiveImages.push(item);
      if (withLiveImages.length >= limit) break;
    }

    res.json({
      source: 'deviantart_rss',
      query: dedupedQueries.join(' || '),
      queries: dedupedQueries,
      allow_mature: allowMature,
      quality_floor_min_edge: minEdge,
      count: withLiveImages.length,
      items: withLiveImages
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function searchDeviantArtRss(searchText, limit, { allowMature }) {
  const rssUrl = `https://backend.deviantart.com/rss.xml?q=${encodeURIComponent(searchText)}&type=deviation&mature_content=${allowMature ? 'true' : 'false'}&include_mature=${allowMature ? 'true' : 'false'}`;
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
  const mediaContent = getMediaTag(raw, 'media:content');
  const mediaThumbnail = getMediaTag(raw, 'media:thumbnail');
  const descImage = getImageFromDescription(getTag(raw, 'description'));

  const imageUrl = mediaContent.url || descImage || mediaThumbnail.url;
  const urlDimensions = extractDimensionsFromUrl(imageUrl);
  const imageWidth = mediaContent.width || mediaThumbnail.width || urlDimensions.width || null;
  const imageHeight = mediaContent.height || mediaThumbnail.height || urlDimensions.height || null;

  if (!title || !link || !imageUrl) return null;
  return {
    title,
    link,
    creator: creator || null,
    published_at: pubDate || null,
    image_url: imageUrl,
    image_width: imageWidth,
    image_height: imageHeight
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

function getMediaTag(raw, tagName) {
  const match = raw.match(new RegExp(`<${tagName}([^>]*)\\/?>`, 'i'));
  if (!match) return { url: '', width: null, height: null };
  const attrs = match[1] || '';
  const url = (attrs.match(/url="([^"]+)"/i) || [])[1] || '';
  const widthRaw = (attrs.match(/width="([^"]+)"/i) || [])[1];
  const heightRaw = (attrs.match(/height="([^"]+)"/i) || [])[1];
  const width = widthRaw ? Number(widthRaw) : null;
  const height = heightRaw ? Number(heightRaw) : null;
  return {
    url,
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null
  };
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

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function extractDimensionsFromUrl(url) {
  const str = String(url || '');
  const match = str.match(/(?:w_|width=)(\d+).*(?:h_|height=)(\d+)/i) || str.match(/(?:h_|height=)(\d+).*(?:w_|width=)(\d+)/i);
  if (!match) return { width: null, height: null };
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { width: null, height: null };
  // If the regex hit h_ first branch, this still works because we only need edge sizes.
  return { width: a, height: b };
}

function passesQualityFloor(item, minEdge) {
  const width = Number(item.image_width);
  const height = Number(item.image_height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return Math.max(width, height) >= minEdge;
}

module.exports = router;
