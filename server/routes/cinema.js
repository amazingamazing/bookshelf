const router = require('express').Router();
const fetch = require('node-fetch');
const { pool } = require('../db');

router.get('/series-images/:seriesId', async (req, res) => {
  try {
    const seriesId = Number(req.params.seriesId);
    if (!Number.isFinite(seriesId)) return res.status(400).json({ error: 'Invalid series id' });

    const {
      allow_mature: allowMatureRaw = 'false',
      min_edge: minEdgeRaw = '700',
      exclude_ai: excludeAiRaw = 'true',
      sort_mode: sortModeRaw = 'popular',
      time_window: timeWindowRaw = 'all',
      per_creator_cap: perCreatorCapRaw = '2'
    } = req.query;

    const allowMature = parseBoolean(allowMatureRaw, false);
    const minEdge = Math.max(200, Math.min(4000, Number(minEdgeRaw) || 700));
    const excludeAi = parseBoolean(excludeAiRaw, true);
    const sortMode = normalizeSortMode(sortModeRaw);
    const timeWindow = normalizeTimeWindow(timeWindowRaw);
    const perCreatorCap = Math.max(1, Math.min(5, Number(perCreatorCapRaw) || 2));

    const { rows: seriesRows } = await pool.query(`
      SELECT
        s.id,
        s.name,
        s.tier,
        a.name AS author_name,
        s.cover_url
      FROM series s
      LEFT JOIN authors a ON a.id = s.author_id
      WHERE s.id = $1
      LIMIT 1
    `, [seriesId]);
    const series = seriesRows[0];
    if (!series) return res.status(404).json({ error: 'Series not found' });

    const { rows: bookRows } = await pool.query(`
      SELECT id, title, isbn, cover_url
      FROM books
      WHERE series_id = $1
      ORDER BY series_order NULLS LAST, id
    `, [seriesId]);
    const bookIds = bookRows.map(row => row.id);

    const coverCandidates = bookIds.length ? await fetchCoverCandidates(bookIds) : [];

    const images = [];
    const seen = new Set();

    pushImage(images, seen, {
      url: series.cover_url,
      source: 'series_cover',
      title: series.name,
      creator: null,
      creator_url: null,
      external_link: null
    });

    for (const book of bookRows) {
      pushImage(images, seen, {
        url: book.cover_url,
        source: 'book_cover',
        title: book.title,
        creator: null,
        creator_url: null,
        external_link: null
      });
    }

    for (const candidate of coverCandidates) {
      pushImage(images, seen, {
        url: candidate.cover_url,
        source: candidate.source || 'candidate_cover',
        title: candidate.book_title || series.name,
        creator: null,
        creator_url: null,
        external_link: null
      });
    }

    if (images.length < 6) {
      const supplements = await fetchSupplementalCovers(bookRows, 8);
      for (const supplement of supplements) pushImage(images, seen, supplement);
    }

    const fanartItems = await fetchSeriesFanartViaExistingEndpoint(req, seriesId, {
      allowMature,
      minEdge,
      excludeAi,
      sortMode,
      timeWindow,
      perCreatorCap
    });
    for (const item of fanartItems) {
      pushImage(images, seen, {
        url: item.image_url,
        source: 'fanart',
        title: item.title || series.name,
        creator: item.creator || null,
        creator_url: deriveDeviantartArtistUrl(item),
        external_link: item.link || null
      });
    }

    const cappedImages = images.slice(0, 18);
    res.json({
      series: {
        id: series.id,
        name: series.name,
        author_name: series.author_name,
        tier: series.tier
      },
      count: cappedImages.length,
      images: cappedImages
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function fetchCoverCandidates(bookIds) {
  const { rows } = await pool.query(`
    SELECT
      bcc.cover_url,
      bcc.source,
      b.title AS book_title
    FROM book_cover_candidates bcc
    JOIN books b ON b.id = bcc.book_id
    WHERE bcc.book_id = ANY($1::int[])
    ORDER BY
      CASE
        WHEN bcc.source = 'open_library_editions' THEN 1
        WHEN bcc.source = 'open_library_isbn' THEN 2
        WHEN bcc.source = 'google_books_isbn' THEN 3
        WHEN bcc.source = 'librarything_isbn' THEN 4
        WHEN bcc.source = 'internet_archive' THEN 5
        ELSE 8
      END,
      bcc.created_at DESC
  `, [bookIds]);
  return rows || [];
}

async function fetchSupplementalCovers(bookRows, cap) {
  const supplements = [];
  const seen = new Set();
  const isbnPool = Array.from(new Set(bookRows.map(row => normalizeIsbn(row.isbn)).filter(Boolean))).slice(0, 6);

  for (const isbn of isbnPool) {
    if (supplements.length >= cap) break;
    const openLibrary = await findOpenLibraryCoverByIsbn(isbn);
    if (openLibrary && !seen.has(openLibrary.url)) {
      supplements.push(openLibrary);
      seen.add(openLibrary.url);
      if (supplements.length >= cap) break;
    }
    const google = await findGoogleBooksCoverByIsbn(isbn);
    if (google && !seen.has(google.url)) {
      supplements.push(google);
      seen.add(google.url);
    }
  }

  return supplements;
}

async function findOpenLibraryCoverByIsbn(isbn) {
  try {
    const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`);
    if (!res.ok) return null;
    const data = await res.json();
    const row = data[`ISBN:${isbn}`];
    const coverUrl = row?.cover?.large || row?.cover?.medium || row?.cover?.small || null;
    if (!coverUrl) return null;
    return {
      url: coverUrl,
      source: 'open_library_isbn',
      title: row?.title || null,
      creator: null,
      creator_url: null,
      external_link: row?.url || null
    };
  } catch {
    return null;
  }
}

async function findGoogleBooksCoverByIsbn(isbn) {
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`);
    if (!res.ok) return null;
    const data = await res.json();
    const item = data?.items?.[0];
    const links = item?.volumeInfo?.imageLinks || {};
    const coverUrl = links.extraLarge || links.large || links.medium || links.small || links.thumbnail || links.smallThumbnail || null;
    if (!coverUrl) return null;
    return {
      url: toHttps(coverUrl),
      source: 'google_books_isbn',
      title: item?.volumeInfo?.title || null,
      creator: null,
      creator_url: null,
      external_link: item?.volumeInfo?.infoLink || null
    };
  } catch {
    return null;
  }
}

async function fetchSeriesFanartViaExistingEndpoint(req, seriesId, options) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) return [];

  const params = new URLSearchParams({
    series_id: String(seriesId),
    limit: '12',
    allow_mature: options.allowMature ? 'true' : 'false',
    min_edge: String(options.minEdge),
    sort_mode: options.sortMode,
    time_window: options.timeWindow,
    exclude_ai: options.excludeAi ? 'true' : 'false',
    per_creator_cap: String(options.perCreatorCap)
  });

  const url = `${protocol}://${host}/api/fanart/deviantart?${params.toString()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

function pushImage(target, seen, image) {
  const url = String(image?.url || '').trim();
  if (!url) return;
  if (seen.has(url)) return;
  seen.add(url);
  target.push({
    url,
    source: image.source || 'unknown',
    title: image.title || null,
    creator: image.creator || null,
    creator_url: image.creator_url || null,
    external_link: image.external_link || null
  });
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

function normalizeIsbn(value) {
  const raw = String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
  return raw || null;
}

function toHttps(value) {
  return String(value || '').replace(/^http:\/\//i, 'https://');
}

function parseBoolean(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeSortMode(value) {
  return String(value || '').trim().toLowerCase() === 'newest' ? 'newest' : 'popular';
}

function normalizeTimeWindow(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1y', '3y', '5y', '10y', 'all'].includes(normalized)) return normalized;
  return 'all';
}

module.exports = router;
