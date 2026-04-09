const router = require('express').Router();
const { pool } = require('../db');

// Get all series with book counts
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, a.name as author_name,
             COUNT(b.id) as book_count,
             COUNT(CASE WHEN b.status='Read' THEN 1 END) as books_read
      FROM series s
      LEFT JOIN authors a ON s.author_id = a.id
      LEFT JOIN books b ON b.series_id = s.id
      GROUP BY s.id, a.name
      ORDER BY s.tier, s.name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single series with its books
router.get('/:id', async (req, res) => {
  try {
    const { rows: [series] } = await pool.query(`
      SELECT s.*, a.name as author_name
      FROM series s LEFT JOIN authors a ON s.author_id = a.id
      WHERE s.id = $1
    `, [req.params.id]);
    if (!series) return res.status(404).json({ error: 'Not found' });

    const { rows: books } = await pool.query(`
      SELECT b.*, a.name as author_name FROM books b
      LEFT JOIN authors a ON b.author_id = a.id
      WHERE b.series_id = $1 ORDER BY b.series_order
    `, [req.params.id]);

    res.json({ ...series, books });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create series
router.post('/', async (req, res) => {
  try {
    const { name, author_id, tier, rating, status, notes, cover_url } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO series (name, author_id, tier, rating, status, notes, cover_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [name, author_id, tier || 'Unranked', rating, status || 'Want to Read', notes, cover_url]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update series (including tier for tier list)
router.put('/:id', async (req, res) => {
  try {
    const { name, tier, rating, status, notes, cover_url } = req.body;
    const { rows } = await pool.query(`
      UPDATE series SET name=$1, tier=$2, rating=$3, status=$4, notes=$5, cover_url=$6
      WHERE id=$7 RETURNING *
    `, [name, tier, rating, status, notes, cover_url, req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk update tiers (for drag-and-drop tier list)
router.post('/tiers', async (req, res) => {
  try {
    const { tiers } = req.body; // { seriesId: tier, ... }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [id, tier] of Object.entries(tiers)) {
        await client.query('UPDATE series SET tier=$1 WHERE id=$2', [tier, id]);
      }
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete series
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM series WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
