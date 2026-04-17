const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Get AI recommendations based on user's library
router.post('/recommend', async (req, res) => {
  try {
    const { prompt: userPrompt } = req.body;

    // Get user's top-rated series for context
    const { rows: topSeries } = await pool.query(`
      SELECT s.name, a.name as author, s.tier, s.rating
      FROM series s LEFT JOIN authors a ON s.author_id = a.id
      WHERE s.tier IN ('S','A','B') OR s.rating >= 4
      ORDER BY CASE s.tier WHEN 'S' THEN 1 WHEN 'A' THEN 2 WHEN 'B' THEN 3 ELSE 4 END, s.rating DESC
      LIMIT 20
    `);

    const libraryContext = topSeries.map(s =>
      `- ${s.name} by ${s.author} (Tier: ${s.tier || 'unranked'}, Rating: ${s.rating || 'N/A'})`
    ).join('\n');

    const systemPrompt = `You are a book recommendation expert. The user has a personal bookshelf app tracking their reading history.
Here are their highest-rated series:
${libraryContext}

Based on these preferences, provide thoughtful book series recommendations. Focus on series, not standalone books.
For each recommendation include: series name, author, why they'd like it (based on what they enjoy), approximate length, and genre tags.
Format as JSON array: [{"name":"...","author":"...","reason":"...","books_count":N,"genres":["..."]}]
Return ONLY the JSON array, no other text.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: userPrompt || 'Recommend series similar to what I enjoy' }],
      system: systemPrompt
    });

    const lastContent = message.content[message.content.length - 1];
    const text = lastContent.type === 'text' ? lastContent.text : '';
    const recommendations = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
    res.json(recommendations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check for new releases from followed authors
router.post('/new-releases', async (req, res) => {
  try {
    const { rows: authors } = await pool.query(
      'SELECT name FROM authors WHERE following=true ORDER BY name'
    );

    if (!authors.length) {
      return res.json({ message: 'No followed authors. Follow some authors to track new releases!', results: [] });
    }

    const authorList = authors.map(a => a.name).join(', ');

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Search for upcoming and recent book releases (2024-2025) from these authors: ${authorList}. 
For each author with a new or upcoming release, provide the book title, series name if applicable, expected/actual release date, and a brief description.
Return as JSON array: [{"author":"...","title":"...","series":"...","release_date":"...","description":"...","is_upcoming":true/false}]
Return ONLY the JSON array.`
      }]
    });

    const lastContent = message.content[message.content.length - 1];
    const text = lastContent.type === 'text' ? lastContent.text : '';
    const results = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Research a specific series
router.post('/research', async (req, res) => {
  try {
    const { query } = req.body;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Research this book/series and provide detailed information: ${query}
Include: full series name, author, number of books, genre, brief synopsis, publication status (ongoing/complete), average ratings, and similar series.
Return as JSON: {"name":"...","author":"...","book_count":N,"status":"ongoing/complete","genre":"...","synopsis":"...","similar_series":["..."],"goodreads_rating":N}`
      }]
    });

    const lastContent = message.content[message.content.length - 1];
    const text = lastContent.type === 'text' ? lastContent.text : '';
    const result = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reddit-discover', async (req, res) => {
  try {
    const payload = req.body || {};
    const context = await resolveSeriesDiscoveryContext(payload);
    if (!context) {
      return res.status(400).json({ error: 'Provide series_id or series_name' });
    }
    const aiResult = await discoverRedditTargetsViaClaude(context);
    const sanitized = sanitizeRedditDiscovery(aiResult, context);
    res.json({
      series: context,
      ...sanitized
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function resolveSeriesDiscoveryContext(payload) {
  const seriesId = Number(payload.series_id);
  if (Number.isFinite(seriesId)) {
    const { rows } = await pool.query(`
      SELECT
        s.id,
        s.name AS series_name,
        a.name AS author_name,
        (
          SELECT b1.title
          FROM books b1
          WHERE b1.series_id = s.id
          ORDER BY b1.series_order NULLS LAST, b1.id
          LIMIT 1
        ) AS first_book_title
      FROM series s
      LEFT JOIN authors a ON a.id = s.author_id
      WHERE s.id = $1
      LIMIT 1
    `, [seriesId]);
    if (!rows[0]) return null;
    return rows[0];
  }
  const seriesName = String(payload.series_name || '').trim();
  if (!seriesName) return null;
  return {
    id: null,
    series_name: seriesName,
    author_name: String(payload.author_name || '').trim() || null,
    first_book_title: String(payload.first_book_title || '').trim() || null
  };
}

async function discoverRedditTargetsViaClaude(context) {
  const seriesName = String(context?.series_name || '').trim();
  const authorName = String(context?.author_name || '').trim();
  const firstBookTitle = String(context?.first_book_title || '').trim();
  const prompt = [
    `Find Reddit communities and search terms for fan art about this book series.`,
    `Series: ${seriesName}`,
    authorName ? `Author: ${authorName}` : null,
    firstBookTitle ? `First book: ${firstBookTitle}` : null,
    'Return ONLY JSON with keys: subreddits, queries, notes.',
    'subreddits must be array of subreddit names only (no r/ prefix).',
    'queries must be short phrase queries for Reddit search, no punctuation-heavy strings.',
    'Rank by likely fan-art relevance.',
    'Return 6-12 subreddits and 4-10 queries.'
  ].filter(Boolean).join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }]
  });
  const lastContent = message.content[message.content.length - 1];
  const text = lastContent.type === 'text' ? lastContent.text : '';
  return parseJsonPayload(text);
}

function parseJsonPayload(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};
  const stripped = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  return JSON.parse(stripped);
}

function sanitizeRedditDiscovery(aiResult, context) {
  const fallbackQueries = buildFallbackQueries(context);
  const fallbackSubreddits = [
    'fanart',
    'ImaginaryNetwork',
    'CharacterDrawing',
    'digitalart',
    'Fantasy',
    'progressionfantasy',
    'litrpg',
    'books'
  ];
  const subreddits = dedupeCleanSubreddits(aiResult?.subreddits || []).slice(0, 12);
  const queries = dedupeCleanQueries(aiResult?.queries || []).slice(0, 10);
  return {
    subreddits: subreddits.length ? subreddits : fallbackSubreddits,
    queries: queries.length ? queries : fallbackQueries,
    notes: String(aiResult?.notes || '').trim() || null
  };
}

function dedupeCleanSubreddits(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const cleaned = String(value || '')
      .trim()
      .replace(/^\/?r\//i, '')
      .replace(/[^a-zA-Z0-9_]/g, '')
      .toLowerCase();
    if (!cleaned || cleaned.length < 2 || cleaned.length > 21) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function dedupeCleanQueries(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const cleaned = String(value || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length < 2 || cleaned.length > 80) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function buildFallbackQueries(context) {
  const seriesName = String(context?.series_name || '').trim();
  const authorName = String(context?.author_name || '').trim();
  const firstBookTitle = String(context?.first_book_title || '').trim();
  const fallback = [];
  if (seriesName) fallback.push(seriesName);
  if (seriesName && authorName) fallback.push(`${seriesName} ${authorName}`);
  if (firstBookTitle) fallback.push(firstBookTitle);
  if (firstBookTitle && seriesName) fallback.push(`${firstBookTitle} ${seriesName}`);
  return dedupeCleanQueries(fallback).slice(0, 10);
}

module.exports = router;
