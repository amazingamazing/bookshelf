require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/books', require('./routes/books'));
app.use('/api/series', require('./routes/series'));
app.use('/api/authors', require('./routes/authors'));
app.use('/api/import', require('./routes/import'));
app.use('/api/export', require('./routes/export'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/covers', require('./routes/covers'));
app.use('/api/fanart', require('./routes/fanart'));
app.use('/api/cinema', require('./routes/cinema'));

// Serve React frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is not set!');
    console.error('Please set DATABASE_URL to your PostgreSQL connection string.');
    process.exit(1);
  }
  
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Bookshelf running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to initialize database:', err.message);
    console.error('Check that DATABASE_URL is correct and the database is accessible.');
    process.exit(1);
  }
}

start();
