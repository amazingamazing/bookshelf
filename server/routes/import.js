const router = require('express').Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { pool } = require('../db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Strip series/subtitle cruft so "A Storm of Swords: A Song of Ice and Fire, Book 5"
// normalizes to "A Storm of Swords" and matches the Goodreads-stored title.
function normalizeTitle(title) {
  return title
    .replace(/\s*:\s*.+?,?\s*Book\s+[\d.]+.*/i, '') // "Title: Series Name, Book 3"
    .replace(/\s*:\s*Book\s+[\d.]+.*/i, '')          // "Title: Book 3"
    .replace(/[,]?\s*Book\s+[\d.]+\s*$/i, '')        // "Title, Book 3" at end
    .replace(/\s*\([^)]*#[\d.]+[^)]*\)/g, '')        // "(Series Name, #3)"
    .replace(/\s*\([^)]*(?:order)[^)]*\)/gi, '')     // "(Publication Order, #2)"
    .trim();
}

function normalizeSeriesName(raw) {
  if (!raw) return null;
  let name = String(raw).trim();
  if (!name) return null;

  if (name.includes(',')) {
    name = name.split(',')[0].trim();
  }

  name = name
    .replace(/\(\s*book\s*[\d.\-]*\s*\)/ig, '')
    .replace(/\(\s*#\s*[\d.\-]+\s*\)/ig, '')
    .replace(/\s*series$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return name || null;
}

function canonicalSeriesKey(raw) {
  const name = normalizeSeriesName(raw);
  if (!name) return null;
  return name
    .toLowerCase()
    .replace(/^the\s+/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSeriesOrder(raw) {
  if (!raw) return null;
  const m = String(raw).match(/[\d.]+/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

function parseGoodreadsSeriesFromTitle(title) {
  if (!title) return { cleanTitle: '', seriesName: null, seriesOrder: null };
  const t = String(title).trim();

  let m = t.match(/^(.*?)\s*\(([^()]+?)(?:,\s*#\s*([\d.\-]+)|\s+#\s*([\d.\-]+))\)\s*$/i);
  if (m) {
    return {
      cleanTitle: normalizeTitle(m[1].trim()),
      seriesName: normalizeSeriesName(m[2]),
      seriesOrder: parseSeriesOrder(m[3] || m[4] || '1')
    };
  }

  m = t.match(/^(.*?)\s*\(([^()]+?),\s*#\s*([\d.]+)\s*-\s*[\d.]+\)\s*$/i);
  if (m) {
    return {
      cleanTitle: normalizeTitle(m[1].trim()),
      seriesName: normalizeSeriesName(m[2]),
      seriesOrder: parseSeriesOrder(m[3])
    };
  }

  return { cleanTitle: normalizeTitle(t), seriesName: null, seriesOrder: null };
}

function parseAudibleSeries(row, title) {
  let seriesName = normalizeSeriesName(row['Series'] || row['series'] || '');
  let seriesOrder = parseSeriesOrder(row['Book Numbers'] || row['Series Sequence'] || '');

  const byTitle = title?.match(/:\s*([^,:]+?),\s*Book\s+([\d.\-]+)\s*$/i);
  if (!seriesName && byTitle) {
    seriesName = normalizeSeriesName(byTitle[1]);
    seriesOrder = seriesOrder || parseSeriesOrder(byTitle[2]);
  }

  const subtitle = (row['Subtitle'] || row['subtitle'] || '').trim();
  const bySubtitle = subtitle.match(/^([^,:]+?),\s*Book\s+([\d.\-]+)\s*$/i);
  if (!seriesName && bySubtitle) {
    seriesName = normalizeSeriesName(bySubtitle[1]);
    seriesOrder = seriesOrder || parseSeriesOrder(bySubtitle[2]);
  }

  return { seriesName, seriesOrder };
}

// Helper: find or create author
async function findOrCreateAuthor(client, name) {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  let { rows } = await client.query('SELECT id FROM authors WHERE LOWER(name)=LOWER($1)', [trimmed]);
  if (!rows[0]) {
    const res = await client.query('INSERT INTO authors (name) VALUES ($1) RETURNING id', [trimmed]);
    rows = res.rows;
  }
  return rows[0].id;
}

// Helper: find or create series
async function findOrCreateSeries(client, name, authorId) {
  const cleaned = normalizeSeriesName(name);
  const key = canonicalSeriesKey(cleaned);
  if (!cleaned || !key || !authorId) return null;

  const { rows } = await client.query(
    'SELECT id, name FROM series WHERE author_id=$1',
    [authorId]
  );
  const match = rows.find(r => canonicalSeriesKey(r.name) === key);
  if (match) return match.id;

  const res = await client.query(
    'INSERT INTO series (name, author_id) VALUES ($1,$2) RETURNING id',
    [cleaned, authorId]
  );
  return res.rows[0].id;
}

// Nuke test data for rapid re-import cycles
router.post('/reset-all', async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: beforeRows } = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM authors) AS authors,
        (SELECT COUNT(*)::int FROM series) AS series,
        (SELECT COUNT(*)::int FROM books) AS books,
        (SELECT COUNT(*)::int FROM reading_queue) AS queue
    `);
    await client.query('TRUNCATE TABLE reading_queue, books, series, authors RESTART IDENTITY CASCADE');
    await client.query('COMMIT');
    res.json({ success: true, deleted: beforeRows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Goodreads CSV import
router.post('/goodreads', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const records = parse(req.file.buffer.toString('utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    const client = await pool.connect();
    const results = { imported: 0, skipped: 0, errors: [] };

    try {
      await client.query('BEGIN');

      for (const row of records) {
        try {
          const title = row['Title']?.trim();
          if (!title) continue;

          // Parse author (Goodreads format: "Last, First" or "First Last")
          const authorRaw = row['Author']?.trim() || row['Author l-f']?.trim() || '';

          const authorId = await findOrCreateAuthor(client, authorRaw);

          const parsed = parseGoodreadsSeriesFromTitle(title);
          const cleanTitle = parsed.cleanTitle;
          const seriesName = parsed.seriesName;
          const seriesOrder = parsed.seriesOrder;

          const seriesId = authorId ? await findOrCreateSeries(client, seriesName, authorId) : null;

          // Map Goodreads status
          const grShelf = row['Exclusive Shelf'] || row['Bookshelves'] || '';
          let status = 'Want to Read';
          if (grShelf.includes('read') && !grShelf.includes('to-read') && !grShelf.includes('currently')) status = 'Read';
          if (grShelf.includes('currently-reading')) status = 'Currently Reading';
          if (grShelf.includes('to-read')) status = 'Want to Read';

          const rating = row['My Rating'] && row['My Rating'] !== '0' ? parseFloat(row['My Rating']) : null;
          const isbn = row['ISBN13']?.replace(/[="]/g, '') || row['ISBN']?.replace(/[="]/g, '') || null;
          const goodreadsId = row['Book Id'] || null;
          const dateRead = row['Date Read'] || null;
          const pageCount = row['Number of Pages'] ? parseInt(row['Number of Pages']) : null;

          // Skip if already imported
          if (goodreadsId) {
            const existing = await client.query('SELECT id FROM books WHERE goodreads_id=$1', [goodreadsId]);
            if (existing.rows[0]) { results.skipped++; continue; }
          }

          await client.query(`
            INSERT INTO books (title, author_id, series_id, series_order, isbn, goodreads_id,
                               status, rating, date_read, page_count, source)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'goodreads')
          `, [cleanTitle, authorId, seriesId, seriesOrder, isbn, goodreadsId,
              status, rating, dateRead, pageCount]);

          results.imported++;
        } catch (rowErr) {
          results.errors.push({ title: row['Title'], error: rowErr.message });
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Audible CSV import (from Audible Library Extractor browser extension)
router.post('/audible', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const records = parse(req.file.buffer.toString('utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    const client = await pool.connect();
    const results = { imported: 0, skipped: 0, errors: [] };

    try {
      await client.query('BEGIN');

      for (const row of records) {
        try {
          const title = (row['Title'] || row['title'])?.trim();
          if (!title) continue;

          const authorRaw = (row['Author'] || row['author'] || row['Authors'] || '')?.trim();
          const asin = (row['ASIN'] || row['asin'] || '')?.trim();
          const coverUrl = (row['Cover'] || row['cover'] || row['Cover URL'] || row['cover_url'] || row['Image'] || '')?.trim() || null;

          const authorId = await findOrCreateAuthor(client, authorRaw);

          const parsedSeries = parseAudibleSeries(row, title);
          const seriesName = parsedSeries.seriesName;
          const seriesOrder = parsedSeries.seriesOrder;
          const cleanTitle = normalizeTitle(title);

          const seriesId = (seriesName && authorId)
            ? await findOrCreateSeries(client, seriesName, authorId)
            : null;

          // Skip if already imported, but backfill cover if missing
          if (asin) {
            const existing = await client.query('SELECT id FROM books WHERE audible_asin=$1', [asin]);
            if (existing.rows[0]) {
              if (coverUrl) {
                await client.query(
                  'UPDATE books SET cover_url=COALESCE(cover_url,$1) WHERE id=$2',
                  [coverUrl, existing.rows[0].id]
                );
              }
              results.skipped++;
              continue;
            }
          }

          // Check if it exists as a goodreads book, just add the asin
          const existing = await client.query(
            'SELECT id FROM books WHERE LOWER(title)=LOWER($1) AND author_id=$2',
            [cleanTitle, authorId]
          );

          if (existing.rows[0]) {
            await client.query(
              `UPDATE books
               SET audible_asin=$1,
                   cover_url=COALESCE(cover_url,$2),
                   series_id=COALESCE(series_id,$3),
                   series_order=COALESCE(series_order,$4)
               WHERE id=$5`,
              [asin, coverUrl, seriesId, seriesOrder, existing.rows[0].id]
            );
            results.skipped++;
          } else {
            await client.query(`
              INSERT INTO books (title, author_id, series_id, series_order, audible_asin, cover_url, status, source)
              VALUES ($1,$2,$3,$4,$5,$6,'Read','audible')
            `, [cleanTitle, authorId, seriesId, seriesOrder, asin, coverUrl]);
            results.imported++;
          }
        } catch (rowErr) {
          results.errors.push({ title: row['Title'], error: rowErr.message });
        }
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
