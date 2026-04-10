const router = require('express').Router();
const fetch = require('node-fetch');
const { pool } = require('../db');

// Look up cover for a book by ISBN or title+author
router.get('/lookup', async (req, res) => {
  try {
    const { isbn, title, author } = req.query;
    let coverUrl = null;

    if (isbn) {
      // Try Open Library by ISBN first
      const olRes = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
      const olData = await olRes.json();
      const bookData = olData[`ISBN:${isbn}`];
      if (bookData?.cover?.large) coverUrl = bookData.cover.large;
      else if (bookData?.cover?.medium) coverUrl = bookData.cover.medium;
    }

    if (!coverUrl && title) {
      const cleanTitle = title.replace(/\s*\([^)]*#[\d.]+[^)]*\)/g, '').trim();
      const q = encodeURIComponent(`${cleanTitle} ${author || ''}`);
      const searchRes = await fetch(`https://openlibrary.org/search.json?q=${q}&limit=3&fields=cover_i,author_name`);
      const searchData = await searchRes.json();
      const authorLower = (author || '').toLowerCase();
      const doc = searchData.docs?.find(d =>
        d.cover_i && authorLower && d.author_name?.some(a => a.toLowerCase().includes(authorLower.split(' ').slice(-1)[0]))
      ) || searchData.docs?.find(d => d.cover_i);
      if (doc?.cover_i) {
        coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
      }
    }

    res.json({ cover_url: coverUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch covers for all books missing them
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
        let coverUrl = null;
        let method = null;

        if (book.isbn) {
          const olRes = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${book.isbn}&format=json&jscmd=data`);
          const olData = await olRes.json();
          const bookData = olData[`ISBN:${book.isbn}`];
          coverUrl = bookData?.cover?.large || bookData?.cover?.medium || null;
          if (coverUrl) method = 'isbn';
        }

        if (!coverUrl) {
          // Strip series parentheticals like "(The Hunger Games, #3)" before searching
          const cleanTitle = book.title.replace(/\s*\([^)]*#[\d.]+[^)]*\)/g, '').trim();
          const q = encodeURIComponent(`${cleanTitle} ${book.author || ''}`);
          const searchRes = await fetch(`https://openlibrary.org/search.json?q=${q}&limit=3&fields=cover_i,author_name`);
          const searchData = await searchRes.json();
          // Prefer a result whose author matches, fall back to first result with a cover
          const authorLower = (book.author || '').toLowerCase();
          const doc = searchData.docs?.find(d =>
            d.cover_i && authorLower && d.author_name?.some(a => a.toLowerCase().includes(authorLower.split(' ').slice(-1)[0]))
          ) || searchData.docs?.find(d => d.cover_i);
          if (doc?.cover_i) {
            coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
            method = book.isbn ? 'title_fallback' : 'title_only';
          }
        }

        if (coverUrl) {
          await pool.query('UPDATE books SET cover_url=$1 WHERE id=$2', [coverUrl, book.id]);
          updated++;
        } else {
          notFound.push({
            title: book.title,
            author: book.author || null,
            reason: book.isbn ? 'ISBN lookup and title search both returned no cover' : 'No ISBN — title search returned no cover'
          });
        }

        // Rate limit: be kind to Open Library
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        fetchErrors.push({ title: book.title, error: e.message });
      }
    }

    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM books WHERE cover_url IS NULL');
    const remaining = parseInt(countRows[0].count);
    res.json({ updated, remaining, tried: rows.length, notFound, fetchErrors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
