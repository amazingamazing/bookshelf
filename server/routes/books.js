const router = require('express').Router();
const { pool } = require('../db');

// Get all books
router.get('/', async (req, res) => {
  try {
    const { series_id, status, search } = req.query;
    let query = `
      SELECT b.*, a.name as author_name, s.name as series_name
      FROM books b
      LEFT JOIN authors a ON b.author_id = a.id
      LEFT JOIN series s ON b.series_id = s.id
      WHERE 1=1
    `;
    const params = [];
    if (series_id) { params.push(series_id); query += ` AND b.series_id = $${params.length}`; }
    if (status) { params.push(status); query += ` AND b.status = $${params.length}`; }
    if (search) { params.push(`%${search}%`); query += ` AND (b.title ILIKE $${params.length} OR a.name ILIKE $${params.length})`; }
    query += ' ORDER BY s.name, b.series_order, b.title';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single book
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.*, a.name as author_name, s.name as series_name, s.tier as series_tier
      FROM books b
      LEFT JOIN authors a ON b.author_id = a.id
      LEFT JOIN series s ON b.series_id = s.id
      WHERE b.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create book
router.post('/', async (req, res) => {
  try {
    const { title, author_id, series_id, series_order, isbn, cover_url,
            status, rating, date_read, goodreads_id, audible_asin, source, published_date, page_count } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO books (title, author_id, series_id, series_order, isbn, cover_url,
                         status, rating, date_read, goodreads_id, audible_asin, source, published_date, page_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [title, author_id, series_id, series_order, isbn, cover_url,
        status || 'Want to Read', rating, date_read, goodreads_id, audible_asin, source || 'manual', published_date, page_count]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update book
router.put('/:id', async (req, res) => {
  try {
    const { title, series_id, series_order, cover_url, status, rating, date_read } = req.body;
    const { rows } = await pool.query(`
      UPDATE books SET title=$1, series_id=$2, series_order=$3, cover_url=$4,
                       status=$5, rating=$6, date_read=$7
      WHERE id=$8 RETURNING *
    `, [title, series_id, series_order, cover_url, status, rating, date_read, req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete book
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM books WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
