# My Bookshelf App

Personal book tracking app with Goodreads/Audible import, visual bookshelf, series tier lists, and AI-powered recommendations.

---

## First-time Setup & Deployment

### 1. Create a GitHub repo

```bash
# In your terminal, inside this folder:
git init
git add .
git commit -m "Initial bookshelf app"
```

Go to github.com → New repository → name it `bookshelf` → Create (don't add README).

Then run what GitHub shows you, something like:
```bash
git remote add origin https://github.com/YOURUSERNAME/bookshelf.git
git branch -M main
git push -u origin main
```

---

### 2. Set up Render PostgreSQL

1. Go to [render.com/dashboard](https://render.com/dashboard)
2. **New +** → **PostgreSQL**
3. Name: `bookshelf-db`, Region: Oregon (US West), Plan: Free
4. Click **Create Database**
5. Wait ~1 min, then click into it
6. Copy the **Internal Database URL** — save it for step 4

---

### 3. Create Render Web Service

1. **New +** → **Web Service**
2. Connect your GitHub account → select the `bookshelf` repo
3. Settings:
   - **Name:** `bookshelf`
   - **Region:** Oregon (US West) — same as DB
   - **Branch:** main
   - **Runtime:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Plan:** Free

---

### 4. Add Environment Variables in Render

In your web service → **Environment** tab → Add:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | (paste Internal Database URL from step 2) |
| `ANTHROPIC_API_KEY` | Your key from console.anthropic.com |
| `NODE_ENV` | `production` |

Click **Save Changes** — Render will redeploy automatically.

---

### 5. You're live!

Your app will be at `https://bookshelf-XXXX.onrender.com`

---

## Deploying updates

Any time you make changes:
```bash
git add .
git commit -m "describe your changes"
git push
```
Render auto-deploys on every push to main.

---

## Local development

```bash
# Install dependencies
npm install
cd client && npm install && cd ..

# Create .env file
cp .env.example .env
# Edit .env with your DATABASE_URL and ANTHROPIC_API_KEY

# Run backend + frontend separately:
# Terminal 1:
npm run dev

# Terminal 2:
cd client && npm run dev
# Frontend at http://localhost:5173, API at http://localhost:3001
```

---

## Features

- **Bookshelf** — Visual cover grid, zoom in/out, filter by tier/status/search
- **Series View** — Books in series, tier/rating/notes, AI similar series finder
- **Tier List** — Drag-and-drop S/A/B/C/D ranking, export as shareable image
- **Import** — Goodreads CSV, Audible CSV (via Library Extractor extension), manual entry
- **Discover** — AI recommendations, new release tracker, series research
- **Export** — Goodreads-compatible CSV, full data backup, tier list image
