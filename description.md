# Oxford Palliative Medicine — AI Exam & Flashcards

AI-powered exam questions and spaced repetition flashcards from the **Oxford Textbook of Palliative Medicine, 6th Edition**.

Live at: **[henryhe.me/oxfordpal](https://henryhe.me/oxfordpal)**

---

## Features

- 87 chapters covering the full textbook
- AI question generation via the Anthropic API
- Offline flashcard deck — every generated question saved to localStorage
- Spaced repetition (SM-2 / Anki-compatible algorithm)
- Due card study mode with Again / Hard / Good / Easy ratings
- Session history, persistent stats, weakest chapters
- API usage tracker with 5-hour reset countdown
- Light / dark mode (auto system detection + toggle)
- Export full deck as JSON

---

## Setup (two steps)

### Step 1 — Deploy the Cloudflare Worker proxy

The Anthropic API blocks direct browser requests (CORS). You need a tiny proxy — Cloudflare Workers free tier handles this perfectly.

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Worker**
2. Replace the default code with the contents of `worker/worker.js`
3. Click **Deploy**
4. Go to **Settings → Variables** → add an **Environment Variable**:
   - Name: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-...` (your key from [console.anthropic.com](https://console.anthropic.com))
   - Click **Encrypt** then **Save**
5. Note your worker URL — it will look like:
   `https://oxfordpal-proxy.YOUR-SUBDOMAIN.workers.dev`

The free Cloudflare Workers tier includes **100,000 requests/day** — more than enough.

### Step 2 — Set the proxy URL in app.js

Open `app.js` and update the first line:

```js
// Change this to your actual worker URL:
const API_PROXY_URL = 'https://oxfordpal-proxy.myname.workers.dev';
```

---

## Deploy to GitHub Pages (henryhe.me/oxfordpal)

```bash
cd oxfordpal
git init && git add . && git commit -m "init"
gh repo create henryhe1/oxfordpal --public
git remote add origin https://github.com/henryhe1/oxfordpal.git
git push -u origin main
```

Then: GitHub → **Settings → Pages** → Source: **GitHub Actions**.

Since `henryhe.me` points to `henryhe1.github.io`, the path `henryhe.me/oxfordpal` works automatically.

---

## Local development

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

The worker already allows `localhost` origins so local dev works without changes.

---

## API cost note

Your Anthropic API key (in the worker) is separate from your claude.ai account.
Get one at [console.anthropic.com](https://console.anthropic.com) — new accounts get $5 free credit.
At ~$0.003 per question (Sonnet 4), that is roughly 1,600 questions per $5.

---

## Source

> Cherny NI, Fallon MT, Kaasa S, Portenoy RK, Currow DC (eds). *Oxford Textbook of Palliative Medicine*, 6th Edition. Oxford University Press, 2021.
