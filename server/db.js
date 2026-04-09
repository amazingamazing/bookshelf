const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS authors (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        following BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS series (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        author_id INTEGER REFERENCES authors(id),
        tier TEXT CHECK(tier IN ('S','A','B','C','D','Unranked')) DEFAULT 'Unranked',
        rating NUMERIC(3,1),
        status TEXT CHECK(status IN ('Reading','Completed','Dropped','Want to Read')) DEFAULT 'Want to Read',
        notes TEXT,
        cover_url TEXT,
        goodreads_series_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS books (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        author_id INTEGER REFERENCES authors(id),
        series_id INTEGER REFERENCES series(id),
        series_order NUMERIC(5,2),
        isbn TEXT,
        goodreads_id TEXT UNIQUE,
        audible_asin TEXT UNIQUE,
        cover_url TEXT,
        published_date TEXT,
        page_count INTEGER,
        status TEXT CHECK(status IN ('Read','Currently Reading','Want to Read','Dropped')) DEFAULT 'Want to Read',
        rating NUMERIC(3,1),
        date_read TEXT,
        source TEXT CHECK(source IN ('goodreads','audible','manual')) DEFAULT 'manual',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS reading_queue (
        id SERIAL PRIMARY KEY,
        book_id INTEGER REFERENCES books(id),
        series_id INTEGER REFERENCES series(id),
        position INTEGER,
        reason TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
