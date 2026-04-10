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

function canonicalTitleKey(title) {
  return normalizeTitle(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalAuthorKey(author) {
  return (author || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TIER_WEIGHT = { S: 5, A: 4, B: 3, C: 2, D: 1, Unranked: 0 };

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

// Find likely duplicate books (same normalized title + author)
router.get('/duplicates', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        b.id, b.title, b.author_id, b.series_id, b.series_order, b.cover_url,
        b.status, b.source, b.goodreads_id, b.audible_asin, b.isbn,
        b.published_date, b.date_read, b.created_at,
        a.name AS author_name,
        s.name AS series_name
      FROM books b
      LEFT JOIN authors a ON a.id = b.author_id
      LEFT JOIN series s ON s.id = b.series_id
      ORDER BY a.name NULLS LAST, b.title, b.id
    `);

    const groupsByKey = new Map();
    for (const book of rows) {
      const titleKey = canonicalTitleKey(book.title);
      const authorKey = canonicalAuthorKey(book.author_name);
      if (!titleKey) continue;
      const key = `${authorKey}::${titleKey}`;
      if (!groupsByKey.has(key)) {
        groupsByKey.set(key, {
          key,
          canonical_title: titleKey,
          canonical_author: authorKey,
          display_title: book.title,
          display_author: book.author_name || 'Unknown',
          books: []
        });
      }
      groupsByKey.get(key).books.push(book);
    }

    const groups = Array.from(groupsByKey.values())
      .filter(g => g.books.length > 1)
      .map(g => ({
        ...g,
        count: g.books.length,
        books: g.books.sort((a, b) => {
          // Prefer entries with richer external IDs and covers at top.
          const score = (x) =>
            (x.cover_url ? 3 : 0) +
            (x.goodreads_id ? 2 : 0) +
            (x.audible_asin ? 2 : 0) +
            (x.series_id ? 1 : 0);
          const diff = score(b) - score(a);
          if (diff !== 0) return diff;
          return new Date(a.created_at) - new Date(b.created_at);
        })
      }))
      .sort((a, b) => b.count - a.count || a.display_title.localeCompare(b.display_title));

    res.json({ groups, totalGroups: groups.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apply selected cover across a duplicate group, optionally merge/delete extras.
router.post('/duplicates/apply', async (req, res) => {
  const { keepBookId, bookIds, merge = false } = req.body || {};
  const keepId = Number(keepBookId);
  const ids = Array.isArray(bookIds) ? bookIds.map(Number).filter(Number.isFinite) : [];

  if (!Number.isFinite(keepId) || ids.length < 2 || !ids.includes(keepId)) {
    return res.status(400).json({ error: 'Invalid payload. Provide keepBookId and at least 2 bookIds including keepBookId.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, cover_url, goodreads_id, audible_asin, isbn, published_date, date_read,
              series_id, series_order, page_count, rating
       FROM books
       WHERE id = ANY($1::int[])`,
      [ids]
    );
    if (rows.length !== ids.length) {
      throw new Error('Some selected book IDs were not found.');
    }

    const keep = rows.find(r => r.id === keepId);
    const others = rows.filter(r => r.id !== keepId);
    const selectedCover = keep.cover_url || others.find(r => r.cover_url)?.cover_url || null;

    await client.query(
      'UPDATE books SET cover_url=$1 WHERE id = ANY($2::int[])',
      [selectedCover, ids]
    );

    const pick = (field) => keep[field] || others.find(r => r[field])?.[field] || null;

    let deleted = 0;
    if (merge) {
      const removeIds = others.map(r => r.id);
      if (removeIds.length) {
        await client.query('UPDATE reading_queue SET book_id=$1 WHERE book_id = ANY($2::int[])', [keepId, removeIds]);
        const del = await client.query('DELETE FROM books WHERE id = ANY($1::int[])', [removeIds]);
        deleted = del.rowCount;
      }

      // Now that donor rows are removed, it is safe to copy unique identifiers.
      await client.query(
        `UPDATE books
         SET goodreads_id=COALESCE(goodreads_id,$1),
             audible_asin=COALESCE(audible_asin,$2),
             isbn=COALESCE(isbn,$3),
             published_date=COALESCE(published_date,$4),
             date_read=COALESCE(date_read,$5),
             series_id=COALESCE(series_id,$6),
             series_order=COALESCE(series_order,$7),
             page_count=COALESCE(page_count,$8),
             rating=COALESCE(rating,$9)
         WHERE id=$10`,
        [
          pick('goodreads_id'),
          pick('audible_asin'),
          pick('isbn'),
          pick('published_date'),
          pick('date_read'),
          pick('series_id'),
          pick('series_order'),
          pick('page_count'),
          pick('rating'),
          keepId
        ]
      );
    } else {
      // In non-merge mode, only propagate non-unique fields.
      await client.query(
        `UPDATE books
         SET published_date=COALESCE(published_date,$1),
             date_read=COALESCE(date_read,$2),
             series_id=COALESCE(series_id,$3),
             series_order=COALESCE(series_order,$4),
             page_count=COALESCE(page_count,$5),
             rating=COALESCE(rating,$6)
         WHERE id=$7`,
        [
          pick('published_date'),
          pick('date_read'),
          pick('series_id'),
          pick('series_order'),
          pick('page_count'),
          pick('rating'),
          keepId
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, kept: keepId, merged: !!merge, deleted, cover_url: selectedCover });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Merge split series rows that share the same canonical series name.
router.post('/repair-series', async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT
        s.id, s.name, s.author_id, s.tier, s.cover_url, s.notes, s.status,
        COUNT(b.id)::int AS book_count
      FROM series s
      LEFT JOIN books b ON b.series_id = s.id
      GROUP BY s.id
      ORDER BY s.id
    `);

    const groups = new Map();
    for (const s of rows) {
      const key = canonicalSeriesKey(s.name);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    const mergeGroups = Array.from(groups.values()).filter(g => g.length > 1);
    const report = [];
    let mergedSeriesRows = 0;
    let movedBooks = 0;

    for (const group of mergeGroups) {
      const sorted = [...group].sort((a, b) => {
        if (b.book_count !== a.book_count) return b.book_count - a.book_count;
        return a.id - b.id;
      });
      const keep = sorted[0];
      const remove = sorted.slice(1);
      if (!remove.length) continue;

      const keepTier = keep.tier || 'Unranked';
      const bestTier = [...group].reduce((best, cur) => {
        return (TIER_WEIGHT[cur.tier] || 0) > (TIER_WEIGHT[best] || 0) ? cur.tier : best;
      }, keepTier);

      const bestCover = keep.cover_url || group.find(s => s.cover_url)?.cover_url || null;
      const mergedNotes = [keep.notes, ...remove.map(r => r.notes)].filter(Boolean).join('\n\n').trim() || null;

      await client.query(
        `UPDATE series
         SET tier = $1,
             cover_url = COALESCE($2, cover_url),
             notes = COALESCE($3, notes)
         WHERE id = $4`,
        [bestTier, bestCover, mergedNotes, keep.id]
      );

      const removeIds = remove.map(r => r.id);
      const moved = await client.query('UPDATE books SET series_id = $1 WHERE series_id = ANY($2::int[])', [keep.id, removeIds]);
      movedBooks += moved.rowCount;
      await client.query('UPDATE reading_queue SET series_id = $1 WHERE series_id = ANY($2::int[])', [keep.id, removeIds]);
      const del = await client.query('DELETE FROM series WHERE id = ANY($1::int[])', [removeIds]);
      mergedSeriesRows += del.rowCount;

      report.push({
        canonical: canonicalSeriesKey(keep.name),
        kept: { id: keep.id, name: keep.name },
        removed: remove.map(r => ({ id: r.id, name: r.name })),
        moved_books: moved.rowCount
      });
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      groupsMerged: report.length,
      mergedSeriesRows,
      movedBooks,
      report
    });
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
          const releaseDate = (row['Release Date'] || row['release_date'] || row['release date'] || '').trim() || null;

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
              await client.query(
                `UPDATE books
                 SET cover_url=COALESCE(cover_url,$1),
                     published_date=COALESCE(published_date,$2),
                     series_id=COALESCE(series_id,$3),
                     series_order=COALESCE(series_order,$4)
                 WHERE id=$5`,
                [coverUrl, releaseDate, seriesId, seriesOrder, existing.rows[0].id]
              );
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
                   series_order=COALESCE(series_order,$4),
                   published_date=COALESCE(published_date,$5)
               WHERE id=$6`,
              [asin, coverUrl, seriesId, seriesOrder, releaseDate, existing.rows[0].id]
            );
            results.skipped++;
          } else {
            await client.query(`
              INSERT INTO books (title, author_id, series_id, series_order, audible_asin, cover_url, published_date, status, source)
              VALUES ($1,$2,$3,$4,$5,$6,$7,'Read','audible')
            `, [cleanTitle, authorId, seriesId, seriesOrder, asin, coverUrl, releaseDate]);
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
