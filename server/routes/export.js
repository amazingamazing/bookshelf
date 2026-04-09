const router = require('express').Router();
const { pool } = require('../db');

// Export to Goodreads-compatible CSV
router.get('/goodreads', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.title, a.name as author, b.isbn, b.goodreads_id,
             b.rating as my_rating, b.status, b.date_read, b.page_count,
             s.name as series_name, b.series_order
      FROM books b
      LEFT JOIN authors a ON b.author_id = a.id
      LEFT JOIN series s ON b.series_id = s.id
      ORDER BY b.title
    `);

    const statusMap = {
      'Read': 'read',
      'Currently Reading': 'currently-reading',
      'Want to Read': 'to-read',
      'Dropped': 'to-read'
    };

    const header = 'Book Id,Title,Author,ISBN13,My Rating,Exclusive Shelf,Date Read,Number of Pages';
    const csv = [header, ...rows.map(r => {
      const title = r.series_name
        ? `"${r.title} (${r.series_name}${r.series_order ? ', #' + r.series_order : ''})"`
        : `"${r.title}"`;
      return [
        r.goodreads_id || '',
        title,
        `"${r.author || ''}"`,
        r.isbn || '',
        r.my_rating || 0,
        statusMap[r.status] || 'to-read',
        r.date_read || '',
        r.page_count || ''
      ].join(',');
    })].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="bookshelf-goodreads-export.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export tier list data (for frontend to render as image)
router.get('/tierlist', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.name, s.tier, s.rating, s.cover_url, a.name as author_name,
             COUNT(b.id) as book_count
      FROM series s
      LEFT JOIN authors a ON s.author_id = a.id
      LEFT JOIN books b ON b.series_id = s.id
      WHERE s.tier != 'Unranked'
      GROUP BY s.id, a.name
      ORDER BY CASE s.tier WHEN 'S' THEN 1 WHEN 'A' THEN 2 WHEN 'B' THEN 3
                            WHEN 'C' THEN 4 WHEN 'D' THEN 5 ELSE 6 END
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full data backup
router.get('/backup', async (req, res) => {
  try {
    const [books, series, authors] = await Promise.all([
      pool.query('SELECT * FROM books ORDER BY id'),
      pool.query('SELECT * FROM series ORDER BY id'),
      pool.query('SELECT * FROM authors ORDER BY id')
    ]);
    res.json({
      exported_at: new Date().toISOString(),
      books: books.rows,
      series: series.rows,
      authors: authors.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
