const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Get AI recommendations based on user's library
router.post('/recommend', async (req, res) => {
  try {
    const { seriesIds, prompt: userPrompt } = req.body;

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

    const text = message.content[0].text;
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
    ]);

    const lastContent = message.content[message.content.length - 1];
    const text = lastContent.type === 'text' ? lastContent.text : '';
    const result = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
