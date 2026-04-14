const router = require('express').Router();
const fetch = require('node-fetch');
const { Jimp, intToRGBA } = require('jimp');
const { pool } = require('../db');

const FALLBACK_CHAIN = [
  'google_books_isbn',
  'open_library_isbn',
  'librarything_isbn',
  'internet_archive'
];
const PHASH_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const COVER_PHASH_CACHE = new Map();
const TARGET_SERIES_NAMES = ['A Song of Ice and Fire', 'Wheel of Time', 'Harry Potter'];

router.get('/lookup', async (req, res) => {
  try {
    const { isbn, title, author, book_id: bookId } = req.query;
    const candidate = await lookupCoverWaterfall({ isbn, title, author });
    if (candidate?.cover_url && bookId) {
      await saveCoverCandidate({
        bookId: Number(bookId),
        isbn: candidate.isbn || normalizeIsbn(isbn),
        coverUrl: candidate.cover_url,
        source: candidate.source,
        metadata: candidate.metadata || null
      });
    }
    res.json(candidate || { cover_url: null, source: null, attempts: FALLBACK_CHAIN });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/fetch-missing', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.id, b.title, b.isbn, a.name as author
      FROM books b LEFT JOIN authors a ON b.author_id = a.id
      WHERE b.cover_url IS NULL LIMIT 50
    `);

    let updated = 0;
    const notFound = [];
    const fetchErrors = [];

    for (const book of rows) {
      try {
        const candidate = await lookupCoverWaterfall({
          isbn: book.isbn,
          title: book.title,
          author: book.author
        });

        if (candidate?.cover_url) {
          await pool.query('UPDATE books SET cover_url=$1 WHERE id=$2', [candidate.cover_url, book.id]);
          await saveCoverCandidate({
            bookId: book.id,
            isbn: candidate.isbn || normalizeIsbn(book.isbn),
            coverUrl: candidate.cover_url,
            source: candidate.source,
            metadata: candidate.metadata || null
          });
          updated++;
        } else {
          notFound.push({
            title: book.title,
            author: book.author || null,
            reason: 'No cover found via Google Books, Open Library, LibraryThing, or Internet Archive'
          });
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        fetchErrors.push({ title: book.title, error: e.message });
      }
    }

    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM books WHERE cover_url IS NULL');
    const remaining = parseInt(countRows[0].count);
    res.json({ updated, remaining, tried: rows.length, notFound, fetchErrors, chain: FALLBACK_CHAIN });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/editions', async (req, res) => {
  try {
    const { book_id: rawBookId, isbn: rawIsbn, title: rawTitle, author: rawAuthor, debug: rawDebug } = req.query;
    const bookId = rawBookId ? Number(rawBookId) : null;
    const includeDebug = rawDebug === '1' || rawDebug === 'true';
    const debugLog = [];
    const logDebug = (step, details = {}) => {
      if (!includeDebug) return;
      debugLog.push({
        ts: new Date().toISOString(),
        step,
        ...details
      });
    };

    let isbn = rawIsbn;
    let title = rawTitle;
    let author = rawAuthor;
    logDebug('request_received', {
      book_id: bookId || null,
      isbn: normalizeIsbn(isbn),
      title: title || null,
      author: author || null
    });

    if (bookId) {
      const { rows } = await pool.query(`
        SELECT b.title, b.isbn, a.name AS author_name
        FROM books b
        LEFT JOIN authors a ON a.id = b.author_id
        WHERE b.id = $1
      `, [bookId]);
      if (!rows[0]) return res.status(404).json({ error: 'Book not found' });
      if (!isbn) isbn = rows[0].isbn;
      if (!title) title = rows[0].title;
      if (!author) author = rows[0].author_name;
      logDebug('book_hydrated_from_db', {
        isbn: normalizeIsbn(isbn),
        title: title || null,
        author: author || null
      });
    }

    const workKey = await resolveOpenLibraryWork({ isbn, title, author, logDebug });
    logDebug('work_resolution_complete', { work_key: workKey || null });
    if (!workKey) {
      return res.json({
        work_key: null,
        editions: [],
        candidates_saved: 0,
        debug: includeDebug ? debugLog : undefined
      });
    }

    const editionsRaw = await fetchOpenLibraryEditions(workKey, 120, logDebug);
    const editions = editionsRaw
      .map(edition => normalizeEdition(edition))
      .filter(edition => edition && edition.cover_urls.length > 0);
    logDebug('editions_normalized', {
      raw_count: editionsRaw.length,
      with_cover_count: editions.length
    });

    let saved = 0;
    if (bookId) {
      for (const edition of editions) {
        for (const coverUrl of edition.cover_urls) {
          const isbnForEdition = edition.isbns[0] || null;
          await saveCoverCandidate({
            bookId,
            isbn: isbnForEdition,
            coverUrl,
            source: 'open_library_editions',
            metadata: {
              work_key: workKey,
              edition_key: edition.edition_key,
              title: edition.title,
              publish_date: edition.publish_date,
              all_isbns: edition.isbns
            }
          });
          saved++;
        }
      }
    }
    logDebug('candidates_saved', { count: saved });

    res.json({
      work_key: workKey,
      editions,
      candidates_saved: saved,
      debug: includeDebug ? debugLog : undefined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/select', async (req, res) => {
  try {
    const { book_id: rawBookId, cover_url: coverUrl, isbn: rawIsbn, source = 'manual_select', metadata = null } = req.body || {};
    const bookId = Number(rawBookId);
    const isbn = normalizeIsbn(rawIsbn);

    if (!bookId || !coverUrl) {
      return res.status(400).json({ error: 'book_id and cover_url are required' });
    }

    await pool.query(
      'UPDATE books SET cover_url = $1, isbn = COALESCE($2, isbn) WHERE id = $3',
      [coverUrl, isbn, bookId]
    );

    await saveCoverCandidate({ bookId, isbn, coverUrl, source, metadata });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/similarity-lab', async (req, res) => {
  try {
    const requestedDistance = Number(req.query.distance);
    const distanceThreshold = Number.isFinite(requestedDistance)
      ? Math.max(0, Math.min(30, Math.round(requestedDistance)))
      : 8;
    const seriesNames = parseSeriesNames(req.query.series_names);

    const { rows } = await pool.query(`
      WITH target_series AS (
        SELECT id, name
        FROM series
        WHERE EXISTS (
          SELECT 1
          FROM unnest($1::text[]) AS needle
          WHERE lower(name) LIKE '%' || needle || '%'
        )
      ),
      primary_covers AS (
        SELECT
          b.id AS book_id,
          b.title AS book_title,
          b.series_order,
          s.id AS series_id,
          s.name AS series_name,
          b.cover_url,
          'book_cover'::text AS source,
          true AS is_primary,
          b.created_at AS discovered_at
        FROM books b
        JOIN target_series s ON s.id = b.series_id
        WHERE b.cover_url IS NOT NULL
          AND b.cover_url <> ''
      ),
      ranked_candidates AS (
        SELECT
          b.id AS book_id,
          b.title AS book_title,
          b.series_order,
          s.id AS series_id,
          s.name AS series_name,
          c.cover_url,
          c.source,
          false AS is_primary,
          c.created_at AS discovered_at,
          ROW_NUMBER() OVER (
            PARTITION BY c.book_id
            ORDER BY c.created_at DESC, c.id DESC
          ) AS candidate_rank
        FROM book_cover_candidates c
        JOIN books b ON b.id = c.book_id
        JOIN target_series s ON s.id = b.series_id
        WHERE c.cover_url IS NOT NULL
          AND c.cover_url <> ''
      )
      SELECT
        book_id,
        book_title,
        series_order,
        series_id,
        series_name,
        cover_url,
        source,
        is_primary,
        discovered_at
      FROM primary_covers
      UNION ALL
      SELECT
        book_id,
        book_title,
        series_order,
        series_id,
        series_name,
        cover_url,
        source,
        is_primary,
        discovered_at
      FROM ranked_candidates
      WHERE candidate_rank <= 10
      ORDER BY series_name, series_order NULLS LAST, book_title, is_primary DESC, discovered_at DESC
    `, [seriesNames.map(name => name.toLowerCase())]);

    const uniqueRecords = dedupeCoverRows(rows);
    const hashed = await mapWithConcurrency(uniqueRecords, 6, async (row) => {
      const hashResult = await getPerceptualHashForUrl(row.cover_url);
      return {
        ...row,
        hash: hashResult.hash,
        hash_error: hashResult.error || null
      };
    });

    const hashedRows = hashed.filter(item => item.hash);
    const failedRows = hashed.filter(item => !item.hash);
    const clusters = buildSimilarityClusters(hashedRows, distanceThreshold);
    const nearestPairs = buildNearestPairs(hashedRows, 40);

    res.json({
      target_series: seriesNames,
      distance_threshold: distanceThreshold,
      totals: {
        covers_considered: uniqueRecords.length,
        covers_hashed: hashedRows.length,
        covers_failed: failedRows.length,
        clusters: clusters.length
      },
      clusters,
      nearest_pairs: nearestPairs,
      failures: failedRows.map(item => ({
        book_id: item.book_id,
        book_title: item.book_title,
        series_name: item.series_name,
        cover_url: item.cover_url,
        source: item.source,
        hash_error: item.hash_error || 'unknown'
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function lookupCoverWaterfall({ isbn, title, author }) {
  const normalizedIsbn = normalizeIsbn(isbn);
  const attempts = [];

  if (normalizedIsbn) {
    const google = await findGoogleBooksCoverByIsbn(normalizedIsbn);
    attempts.push('google_books_isbn');
    if (google?.cover_url) return { ...google, attempts };

    const openLib = await findOpenLibraryCoverByIsbn(normalizedIsbn);
    attempts.push('open_library_isbn');
    if (openLib?.cover_url) return { ...openLib, attempts };

    const libraryThing = await findLibraryThingCoverByIsbn(normalizedIsbn);
    attempts.push('librarything_isbn');
    if (libraryThing?.cover_url) return { ...libraryThing, attempts };
  }

  const archive = await findInternetArchiveCover({ isbn: normalizedIsbn, title, author });
  attempts.push('internet_archive');
  if (archive?.cover_url) return { ...archive, attempts };

  return { cover_url: null, source: null, attempts };
}

async function findGoogleBooksCoverByIsbn(isbn) {
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`);
  if (!res.ok) return null;
  const data = await res.json();
  const item = data.items?.[0];
  const links = item?.volumeInfo?.imageLinks;
  const coverUrl = links?.extraLarge || links?.large || links?.medium || links?.small || links?.thumbnail || links?.smallThumbnail;
  if (!coverUrl) return null;
  return {
    cover_url: toHttps(coverUrl),
    isbn,
    source: 'google_books_isbn',
    metadata: { google_volume_id: item.id || null }
  };
}

async function findOpenLibraryCoverByIsbn(isbn) {
  const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`);
  if (!res.ok) return null;
  const data = await res.json();
  const bookData = data[`ISBN:${isbn}`];
  const coverUrl = bookData?.cover?.large || bookData?.cover?.medium || bookData?.cover?.small || null;
  if (!coverUrl) return null;
  return {
    cover_url: coverUrl,
    isbn,
    source: 'open_library_isbn',
    metadata: { openlibrary_key: bookData?.key || null }
  };
}

async function findLibraryThingCoverByIsbn(isbn) {
  const devKey = process.env.LIBRARYTHING_DEVKEY;
  if (!devKey) return null;
  const coverUrl = `https://covers.librarything.com/devkey/${encodeURIComponent(devKey)}/large/isbn/${encodeURIComponent(isbn)}`;
  const ok = await urlLooksLikeImage(coverUrl);
  if (!ok) return null;
  return {
    cover_url: coverUrl,
    isbn,
    source: 'librarything_isbn',
    metadata: null
  };
}

async function findInternetArchiveCover({ isbn, title, author }) {
  const candidates = [];
  if (isbn) {
    const byIsbn = await fetchArchiveIdentifiers(`isbn:${quoteQueryValue(isbn)}`);
    candidates.push(...byIsbn);
  }
  if (!candidates.length && title) {
    const cleanedTitle = stripSeriesSuffix(title);
    const query = author
      ? `title:(${quoteQueryValue(cleanedTitle)}) AND creator:(${quoteQueryValue(author)})`
      : `title:(${quoteQueryValue(cleanedTitle)})`;
    const byTitle = await fetchArchiveIdentifiers(query);
    candidates.push(...byTitle);
  }
  const identifier = candidates[0];
  if (!identifier) return null;
  return {
    cover_url: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    isbn: normalizeIsbn(isbn),
    source: 'internet_archive',
    metadata: { archive_identifier: identifier }
  };
}

async function fetchArchiveIdentifiers(query) {
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&rows=5&page=1&output=json`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.response?.docs || []).map(d => d.identifier).filter(Boolean);
}

async function resolveOpenLibraryWork({ isbn, title, author, logDebug = () => {} }) {
  const normalizedIsbn = normalizeIsbn(isbn);
  if (normalizedIsbn) {
    const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(normalizedIsbn)}&format=json&jscmd=data`);
    logDebug('isbn_lookup_attempted', {
      isbn: normalizedIsbn,
      status: res.status
    });
    if (res.ok) {
      const data = await res.json();
      const bookData = data[`ISBN:${normalizedIsbn}`];
      const workKey = bookData?.works?.[0]?.key;
      if (workKey) {
        logDebug('isbn_lookup_work_found', { work_key: workKey });
        return workKey;
      }
      logDebug('isbn_lookup_no_work', {
        has_book_data: Boolean(bookData),
        openlibrary_key: bookData?.key || null
      });
    }
  }

  if (!title) {
    logDebug('title_search_skipped', { reason: 'missing_title' });
    return null;
  }

  const authorLast = (author || '').toLowerCase().split(' ').filter(Boolean).slice(-1)[0];
  const titleVariants = buildTitleVariants(title);
  const queryAttempts = [];

  for (const titleVariant of titleVariants) {
    if (author) {
      queryAttempts.push({
        query: `${titleVariant} ${author}`,
        strategy: 'title_plus_author',
        title_variant: titleVariant
      });
    }
    queryAttempts.push({
      query: titleVariant,
      strategy: 'title_only',
      title_variant: titleVariant
    });
  }

  for (const attempt of queryAttempts) {
    const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(attempt.query)}&limit=10&fields=key,title,author_name`);
    logDebug('title_search_attempted', {
      query: attempt.query,
      strategy: attempt.strategy,
      title_variant: attempt.title_variant,
      status: res.status
    });
    if (!res.ok) continue;

    const data = await res.json();
    const docs = data.docs || [];
    logDebug('title_search_results', {
      query: attempt.query,
      strategy: attempt.strategy,
      docs_count: docs.length,
      top_hits: docs.slice(0, 5).map(doc => ({
        key: doc.key || null,
        title: doc.title || null,
        author_name: (doc.author_name || []).slice(0, 2)
      }))
    });

    const best = pickBestWorkDoc(docs, authorLast);
    if (best?.key) {
      logDebug('title_search_selected_work', {
        query: attempt.query,
        strategy: attempt.strategy,
        work_key: best.key
      });
      return best.key;
    }
  }

  logDebug('title_search_selected_work', { work_key: null });
  return null;
}

async function fetchOpenLibraryEditions(workKey, maxRows, logDebug = () => {}) {
  const editions = [];
  let offset = 0;
  const pageSize = 50;

  while (editions.length < maxRows) {
    const res = await fetch(`https://openlibrary.org${workKey}/editions.json?limit=${pageSize}&offset=${offset}`);
    logDebug('editions_page_requested', { offset, status: res.status });
    if (!res.ok) break;
    const data = await res.json();
    const pageEntries = data.entries || [];
    editions.push(...pageEntries);
    logDebug('editions_page_received', {
      offset,
      page_count: pageEntries.length,
      running_total: editions.length
    });
    if (!pageEntries.length || pageEntries.length < pageSize) break;
    offset += pageSize;
  }

  return editions.slice(0, maxRows);
}

function normalizeEdition(edition) {
  const isbns = Array.from(new Set([
    ...(edition.isbn_13 || []),
    ...(edition.isbn_10 || [])
  ].map(normalizeIsbn).filter(Boolean)));
  const coverUrls = Array.from(new Set((edition.covers || []).map(coverId => (
    `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
  ))));
  if (!coverUrls.length) return null;
  return {
    edition_key: edition.key || null,
    title: edition.title || null,
    publish_date: edition.publish_date || null,
    isbns,
    cover_urls: coverUrls
  };
}

async function saveCoverCandidate({ bookId, isbn, coverUrl, source, metadata }) {
  if (!bookId || !coverUrl || !source) return;
  await pool.query(`
    INSERT INTO book_cover_candidates (book_id, isbn, cover_url, source, metadata)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    ON CONFLICT (book_id, source, cover_url)
    DO UPDATE SET
      isbn = COALESCE(EXCLUDED.isbn, book_cover_candidates.isbn),
      metadata = COALESCE(EXCLUDED.metadata, book_cover_candidates.metadata)
  `, [bookId, normalizeIsbn(isbn), coverUrl, source, metadata ? JSON.stringify(metadata) : null]);
}

function normalizeIsbn(value) {
  if (!value) return null;
  const clean = String(value).toUpperCase().replace(/[^0-9X]/g, '');
  return clean || null;
}

function stripSeriesSuffix(title) {
  return String(title || '').replace(/\s*\([^)]*#[\d.]+[^)]*\)/g, '').trim();
}

function stripSubtitle(title) {
  return String(title || '').split(':')[0].trim();
}

function buildTitleVariants(title) {
  const raw = String(title || '').trim();
  const noSeriesSuffix = stripSeriesSuffix(raw);
  const noSubtitle = stripSubtitle(noSeriesSuffix);
  return Array.from(new Set([raw, noSeriesSuffix, noSubtitle].filter(Boolean)));
}

function pickBestWorkDoc(docs, authorLast) {
  return (docs || []).find(doc =>
    doc.key?.startsWith('/works/') &&
    (!authorLast || doc.author_name?.some(name => String(name).toLowerCase().includes(authorLast)))
  ) || (docs || []).find(doc => doc.key?.startsWith('/works/')) || null;
}

function quoteQueryValue(value) {
  return String(value || '').replace(/"/g, '\\"');
}

function toHttps(url) {
  return String(url || '').replace(/^http:\/\//i, 'https://');
}

function parseSeriesNames(rawSeriesNames) {
  const normalized = String(rawSeriesNames || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (normalized.length) return Array.from(new Set(normalized));
  return TARGET_SERIES_NAMES;
}

function dedupeCoverRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const url = String(row.cover_url || '').trim();
    if (!url) continue;
    const key = `${row.book_id}::${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      book_id: Number(row.book_id),
      book_title: row.book_title || null,
      series_order: row.series_order == null ? null : Number(row.series_order),
      series_id: Number(row.series_id),
      series_name: row.series_name || null,
      cover_url: url,
      source: row.source || 'unknown',
      is_primary: Boolean(row.is_primary),
      discovered_at: row.discovered_at || null
    });
  }
  return out;
}

async function getPerceptualHashForUrl(url) {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) return { hash: null, error: 'missing_url' };

  const cached = COVER_PHASH_CACHE.get(normalizedUrl);
  if (cached && (Date.now() - cached.updated_at) < PHASH_CACHE_TTL_MS) {
    return { hash: cached.hash, error: cached.error };
  }

  try {
    const response = await fetch(normalizedUrl, { timeout: 20000 });
    if (!response.ok) {
      const result = { hash: null, error: `http_${response.status}`, updated_at: Date.now() };
      COVER_PHASH_CACHE.set(normalizedUrl, result);
      return { hash: result.hash, error: result.error };
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('image/')) {
      const result = { hash: null, error: `content_type_${contentType}`, updated_at: Date.now() };
      COVER_PHASH_CACHE.set(normalizedUrl, result);
      return { hash: result.hash, error: result.error };
    }
    const buffer = await response.buffer();
    const hash = await computePHashHex(buffer);
    const result = { hash, error: null, updated_at: Date.now() };
    COVER_PHASH_CACHE.set(normalizedUrl, result);
    return { hash: result.hash, error: result.error };
  } catch (err) {
    const result = { hash: null, error: err.message || 'fetch_failed', updated_at: Date.now() };
    COVER_PHASH_CACHE.set(normalizedUrl, result);
    return { hash: result.hash, error: result.error };
  }
}

async function computePHashHex(buffer) {
  const image = await Jimp.read(buffer);
  image.resize({ w: 32, h: 32 });
  image.grayscale();
  const pixels = [];
  for (let y = 0; y < 32; y += 1) {
    const row = [];
    for (let x = 0; x < 32; x += 1) {
      const rgba = intToRGBA(image.getPixelColor(x, y));
      row.push(Number(rgba.r || 0));
    }
    pixels.push(row);
  }
  const dct = dct2d(pixels, 32);
  const topLeft = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (x === 0 && y === 0) continue;
      topLeft.push(dct[y][x]);
    }
  }
  const average = topLeft.reduce((sum, value) => sum + value, 0) / Math.max(1, topLeft.length);
  const bits = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      bits.push(dct[y][x] > average ? 1 : 0);
    }
  }
  return bitsToHex(bits);
}

function dct2d(matrix, size) {
  const out = Array.from({ length: size }, () => Array(size).fill(0));
  const factor = Math.PI / (size * 2);

  for (let v = 0; v < size; v += 1) {
    for (let u = 0; u < size; u += 1) {
      let sum = 0;
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          sum += matrix[y][x]
            * Math.cos((2 * x + 1) * u * factor)
            * Math.cos((2 * y + 1) * v * factor);
        }
      }
      const alphaU = u === 0 ? 1 / Math.sqrt(2) : 1;
      const alphaV = v === 0 ? 1 / Math.sqrt(2) : 1;
      out[v][u] = (2 / size) * alphaU * alphaV * sum;
    }
  }
  return out;
}

function bitsToHex(bits) {
  let output = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = ((bits[i] || 0) << 3)
      | ((bits[i + 1] || 0) << 2)
      | ((bits[i + 2] || 0) << 1)
      | (bits[i + 3] || 0);
    output += nibble.toString(16);
  }
  return output;
}

function hammingDistanceHex(a, b) {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = parseInt(a[i], 16);
    const right = parseInt(b[i], 16);
    const xor = left ^ right;
    distance += BIT_COUNT_LOOKUP[xor];
  }
  return distance;
}

function buildSimilarityClusters(items, threshold) {
  const union = new UnionFind(items.length);
  const distances = new Map();

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const distance = hammingDistanceHex(items[i].hash, items[j].hash);
      distances.set(pairKey(i, j), distance);
      if (distance <= threshold) union.union(i, j);
    }
  }

  const grouped = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const root = union.find(i);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(i);
  }

  const clusters = [];
  for (const indices of grouped.values()) {
    const anchorIndex = pickClusterAnchor(indices, distances);
    const anchor = items[anchorIndex];
    const members = indices
      .map(index => {
        const item = items[index];
        const distanceToAnchor = index === anchorIndex
          ? 0
          : readPairDistance(anchorIndex, index, distances);
        return {
          ...item,
          distance_to_anchor: distanceToAnchor
        };
      })
      .sort((a, b) => (
        a.distance_to_anchor - b.distance_to_anchor
        || Number(b.is_primary) - Number(a.is_primary)
        || String(a.series_name || '').localeCompare(String(b.series_name || ''))
        || (a.series_order ?? Number.MAX_SAFE_INTEGER) - (b.series_order ?? Number.MAX_SAFE_INTEGER)
        || String(a.book_title || '').localeCompare(String(b.book_title || ''))
      ));

    let maxDistance = 0;
    for (let i = 0; i < indices.length; i += 1) {
      for (let j = i + 1; j < indices.length; j += 1) {
        const d = readPairDistance(indices[i], indices[j], distances);
        if (d > maxDistance) maxDistance = d;
      }
    }

    clusters.push({
      id: `cluster_${clusters.length + 1}`,
      size: members.length,
      max_internal_distance: maxDistance,
      anchor: {
        book_id: anchor.book_id,
        book_title: anchor.book_title,
        series_name: anchor.series_name,
        cover_url: anchor.cover_url,
        hash: anchor.hash
      },
      items: members
    });
  }

  return clusters.sort((a, b) => (
    b.size - a.size
    || a.max_internal_distance - b.max_internal_distance
    || String(a.anchor.series_name || '').localeCompare(String(b.anchor.series_name || ''))
    || String(a.anchor.book_title || '').localeCompare(String(b.anchor.book_title || ''))
  ));
}

function pickClusterAnchor(indices, distances) {
  if (indices.length <= 1) return indices[0];
  let bestIndex = indices[0];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of indices) {
    let score = 0;
    for (const other of indices) {
      if (candidate === other) continue;
      score += readPairDistance(candidate, other, distances);
    }
    if (score < bestScore) {
      bestScore = score;
      bestIndex = candidate;
    }
  }
  return bestIndex;
}

function buildNearestPairs(items, limit) {
  const pairs = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const distance = hammingDistanceHex(items[i].hash, items[j].hash);
      pairs.push({
        distance,
        left: {
          book_id: items[i].book_id,
          book_title: items[i].book_title,
          series_name: items[i].series_name,
          cover_url: items[i].cover_url,
          source: items[i].source
        },
        right: {
          book_id: items[j].book_id,
          book_title: items[j].book_title,
          series_name: items[j].series_name,
          cover_url: items[j].cover_url,
          source: items[j].source
        }
      });
    }
  }
  return pairs
    .sort((a, b) => (
      a.distance - b.distance
      || String(a.left.series_name || '').localeCompare(String(b.left.series_name || ''))
      || String(a.left.book_title || '').localeCompare(String(b.left.book_title || ''))
    ))
    .slice(0, Math.max(0, Number(limit) || 0));
}

function pairKey(left, right) {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function readPairDistance(left, right, distances) {
  return distances.get(pairKey(left, right)) ?? Number.POSITIVE_INFINITY;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const safeItems = Array.isArray(items) ? items : [];
  const safeConcurrency = Math.max(1, Number(concurrency) || 1);
  const results = new Array(safeItems.length);
  let cursor = 0;

  async function worker() {
    while (cursor < safeItems.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(safeItems[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(safeConcurrency, safeItems.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = Array(size).fill(0);
  }

  find(index) {
    if (this.parent[index] !== index) {
      this.parent[index] = this.find(this.parent[index]);
    }
    return this.parent[index];
  }

  union(left, right) {
    const rootLeft = this.find(left);
    const rootRight = this.find(right);
    if (rootLeft === rootRight) return;

    if (this.rank[rootLeft] < this.rank[rootRight]) {
      this.parent[rootLeft] = rootRight;
      return;
    }
    if (this.rank[rootLeft] > this.rank[rootRight]) {
      this.parent[rootRight] = rootLeft;
      return;
    }
    this.parent[rootRight] = rootLeft;
    this.rank[rootLeft] += 1;
  }
}

const BIT_COUNT_LOOKUP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

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
