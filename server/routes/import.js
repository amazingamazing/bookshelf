const router = require('express').Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { pool } = require('../db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
  if (!name?.trim()) return null;
  let { rows } = await client.query(
    'SELECT id FROM series WHERE LOWER(name)=LOWER($1) AND author_id=$2',
    [name.trim(), authorId]
  );
  if (!rows[0]) {
    const res = await client.query(
      'INSERT INTO series (name, author_id) VALUES ($1,$2) RETURNING id',
      [name.trim(), authorId]
    );
    rows = res.rows;
  }
  return rows[0].id;
}

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

          // Parse series from title (Goodreads often puts series in parens)
          let seriesName = null;
          let seriesOrder = null;
          let cleanTitle = title;

          const seriesMatch = title.match(/^(.*?)\s*\(([^,#]+)(?:[,#]\s*([\d.]+))?\)\s*$/);
          if (seriesMatch) {
            cleanTitle = seriesMatch[1].trim();
            seriesName = seriesMatch[2].trim();
            seriesOrder = seriesMatch[3] ? parseFloat(seriesMatch[3]) : 1;
          }

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

          // Try to detect series from title
          let seriesName = (row['Series'] || row['series'] || '')?.trim() || null;
          let seriesOrder = row['Series Sequence'] ? parseFloat(row['Series Sequence']) : null;
          let cleanTitle = title;

          if (!seriesName) {
            const m = title.match(/^(.*?)\s*,?\s*Book\s+([\d.]+)/i);
            if (m) { cleanTitle = m[1].trim(); }
          }

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
              'UPDATE books SET audible_asin=$1, cover_url=COALESCE(cover_url,$2) WHERE id=$3',
              [asin, coverUrl, existing.rows[0].id]
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
