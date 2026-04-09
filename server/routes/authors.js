const router = require('express').Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.*, COUNT(DISTINCT s.id) as series_count, COUNT(b.id) as book_count
      FROM authors a
      LEFT JOIN series s ON s.author_id = a.id
      LEFT JOIN books b ON b.author_id = a.id
      GROUP BY a.id ORDER BY a.name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, following } = req.body;
    // Upsert by name
    const { rows } = await pool.query(`
      INSERT INTO authors (name, following) VALUES ($1, $2)
      ON CONFLICT (name) DO UPDATE SET following = EXCLUDED.following
      RETURNING *
    `, [name, following || false]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { following } = req.body;
    const { rows } = await pool.query(
      'UPDATE authors SET following=$1 WHERE id=$2 RETURNING *',
      [following, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get or create author by name (utility used by import)
router.post('/find-or-create', async (req, res) => {
  try {
    const { name } = req.body;
    let { rows } = await pool.query('SELECT * FROM authors WHERE LOWER(name)=LOWER($1)', [name]);
    if (!rows[0]) {
      const result = await pool.query('INSERT INTO authors (name) VALUES ($1) RETURNING *', [name]);
      rows = result.rows;
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
