function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function splitMultiValue(value, delimiter) {
  return String(value || '')
    .split(delimiter)
    .map(clean)
    .filter(Boolean);
}

function canonicalizeToken(token) {
  let t = clean(token);
  if (!t) return null;

  // Keep a single consistent style for known term.
  if (normalized(t) === normalized('litrpg')) return 'LitRPG';
  if (normalized(t) === normalized('sword & sorcery')) return 'Sword & Sorcery';
  return t;
}

function expandTokens(seedLabels) {
  const labels = new Set(seedLabels.map(canonicalizeToken).filter(Boolean));

  for (const label of Array.from(labels)) {
    // Keep specific composite genres as one label; split other ampersands.
    const keepCompositeAmpersand = new Set([
      normalized('Sword & Sorcery'),
      normalized('Action & Adventure')
    ]);
    if (label.includes('&') && !keepCompositeAmpersand.has(normalized(label))) {
      for (const part of label.split('&')) {
        const p = canonicalizeToken(part);
        if (p) labels.add(p);
      }
    }
    if (label.includes('/')) {
      for (const part of label.split('/')) {
        const p = canonicalizeToken(part);
        if (p) labels.add(p);
      }
    }
  }

  // Broad expansions.
  for (const label of Array.from(labels)) {
    const low = label.toLowerCase();
    if (low.includes('epic fantasy')) {
      labels.add('Epic');
      labels.add('Fantasy');
    }
    if (low.includes('science fiction')) labels.add('Science Fiction');
    if (low.includes('litrpg')) labels.add('LitRPG');
    if (low.includes('fantasy')) labels.add('Fantasy');
    if (low.includes('thriller')) labels.add('Thriller');
    if (low.includes('suspense')) labels.add('Suspense');
    if (low.includes('mystery')) labels.add('Mystery');
    if (low.includes('romance')) labels.add('Romance');
  }

  return labels;
}

function isNoise(label) {
  const low = label.toLowerCase();
  const noiseFragments = [
    'award', 'prize', 'best of', 'editors select', 'essentials', '#booktok',
    'tie-ins', 'tie ins'
  ];
  if (noiseFragments.some(f => low.includes(f))) return true;

  const topicalNoise = new Set([
    'abraham lincoln', 'franklin d roosevelt', 'new york', 'montana', 'iran',
    'russia', 'italy', 'china', 'england', 'middle east', 'united states',
    'world', 'europe', 'americas', 'africa', 'imperial japan', 'soviet union',
    'jewish heritage', 'islamic heritage', 'audible essentials',
    'fantasy essentials', 'memoir essentials', 'series essentials',
    "children s audiobooks", 'explore the world'
  ]);
  return topicalNoise.has(normalized(label));
}

function keepLabel(label) {
  if (!label || isNoise(label)) return false;

  const n = normalized(label);
  // Drop most composite labels with comma/&; keep selected composite genres.
  const keepComposite = new Set([
    normalized('Sword & Sorcery'),
    normalized('Action & Adventure')
  ]);
  if ((label.includes('&') || label.includes(',')) && !keepComposite.has(n)) return false;

  // Drop broad literature umbrella labels.
  const banned = new Set([
    normalized('Fiction'),
    normalized('Genre Fiction'),
    normalized('Literature'),
    normalized('Literature & Fiction'),
    normalized('Literary Fiction')
  ]);
  if (banned.has(n)) return false;

  if (keepComposite.has(n)) return true;

  const roots = [
    'action', 'adventure', 'fantasy', 'science fiction', 'horror', 'mystery',
    'thriller', 'suspense', 'crime', 'romance', 'romantasy', 'satire', 'comedy',
    'historical fiction', 'historical', 'classics', 'dystopian', 'apocalyptic',
    'post apocalyptic', 'cyberpunk', 'steampunk', 'space opera', 'first contact',
    'time travel', 'paranormal', 'urban', 'supernatural', 'superhero', 'magic',
    'myth', 'fairy tales', 'mythology', 'coming of age', 'young adult', 'teen',
    'middle grade', 'war', 'military', 'litrpg', 'progression fantasy',
    'biography', 'memoir', 'nonfiction', 'history', 'science', 'philosophy',
    'psychology', 'business', 'politics', 'social sciences', 'self improvement'
  ];
  return roots.some(root => n.includes(root));
}

function applyPluralConflictRule(labels) {
  const set = new Set(labels);
  for (const label of Array.from(set)) {
    const n = normalized(label);
    if (!n.endsWith('s')) continue;
    let singular = null;
    if (n.endsWith('ies')) singular = n.slice(0, -3) + 'y';
    else if (!n.endsWith('ss')) singular = n.slice(0, -1);
    if (!singular) continue;
    // Drop plural only when singular already exists.
    const singularExists = Array.from(set).some(x => normalized(x) === singular);
    if (singularExists) set.delete(label);
  }
  return set;
}

function titleCaseLabel(label) {
  if (label === 'LitRPG' || label === 'Sword & Sorcery') return label;
  return label
    .split(' ')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

function extractAudibleGenreLabels(row) {
  const raw = [];
  raw.push(...splitMultiValue(row.Tags, ','));
  raw.push(...splitMultiValue(row.Categories, '>'));
  raw.push(clean(row['Parent Category']));
  raw.push(clean(row['Child Category']));

  const expanded = expandTokens(raw);
  const filtered = Array.from(expanded).filter(keepLabel);
  const conflictResolved = applyPluralConflictRule(filtered);

  return Array.from(conflictResolved)
    .map(titleCaseLabel)
    .sort((a, b) => a.localeCompare(b));
}

module.exports = {
  extractAudibleGenreLabels,
  normalized
};
