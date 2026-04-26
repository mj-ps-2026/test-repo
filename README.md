# 📬 Inbox Triage

AI-powered Gmail triage using **Gemini 2.0 Flash** + **GitHub Actions**.

- Runs every 15 minutes, classifies new emails
- Auto-archives political fundraising spam, retail promos, and junk
- Sends a digest email of what's left (with 1-line AI summaries)
- Manual backfill mode to sweep historical inbox

---

## Setup

### 1. Get a Gemini API Key

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Click **Get API key** → **Create API key**
3. Copy the key — this is your `GEMINI_API_KEY`

### 2. Get Gmail OAuth Credentials

You need a **Client ID**, **Client Secret**, and a **Refresh Token** for your Gmail account.

#### A. Create OAuth credentials in Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Enable the **Gmail API**: APIs & Services → Enable APIs → search "Gmail API"
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
5. Application type: **Desktop app**
6. Download the JSON — note `client_id` and `client_secret`
7. Go to **OAuth consent screen** → add your Gmail address as a test user

#### B. Get a Refresh Token

Run this one-time locally to authorize access:

```bash
npm install
node get-token.js
```

This opens a browser, you approve access, and it prints your `GMAIL_REFRESH_TOKEN`.

> `get-token.js` is a helper script included in this repo.

### 3. Add GitHub Secrets

In your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret Name | Value |
|---|---|
| `GMAIL_CLIENT_ID` | From OAuth credentials JSON |
| `GMAIL_CLIENT_SECRET` | From OAuth credentials JSON |
| `GMAIL_REFRESH_TOKEN` | From `node get-token.js` |
| `GEMINI_API_KEY` | From AI Studio |
| `DIGEST_TO_EMAIL` | Your Gmail address (e.g. `you@gmail.com`) |

### 4. Push to GitHub

```bash
git init
git add .
git commit -m "inbox triage"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

The workflow will start running on schedule automatically.

---

## Usage

### Incremental (automatic)
Runs every 15 minutes via cron. Triages emails from the last hour window.

### Manual backfill
Go to **Actions → Inbox Triage → Run workflow** → check **"Backfill mode"** → Run.

This sweeps up to 1 year of inbox history. Run this once when setting up.

### Dry run
Check **"Dry run"** in the manual trigger to see what *would* be archived without actually doing it. Useful for tuning.

---

## Customizing the Rules

Edit `triage.js` to adjust:

**`ALWAYS_KEEP_PATTERNS`** — senders never archived regardless of AI classification:
```js
/monarch\.com$/i,
/igotanoffer\.com$/i,
// add more here
```

**`ALWAYS_ARCHIVE_PATTERNS`** — senders always archived without calling Gemini:
```js
/turnoutpac\.org$/i,
/dccc\.org$/i,
// add more here
```

**The AI prompt** — edit the `classifyBatch()` function to adjust what Gemini considers junk.

---

## How It Works

```
GitHub Actions (every 15 min)
  └─ Fetch inbox threads from last hour (Gmail API)
       └─ Pre-classify via allowlist/blocklist (no AI cost)
            ├─ Always-keep senders → kept
            ├─ Always-archive senders → archived immediately
            └─ Everything else → Gemini 2.0 Flash (batches of 15)
                  ├─ archive → remove INBOX label
                  └─ keep → added to digest
  └─ Send digest email with AI summaries of kept emails
```

---

## Cost

- **Gemini 2.0 Flash**: Free tier includes 1,500 requests/day — more than enough for 15-min polling
- **GitHub Actions**: Free tier includes 2,000 min/month — each run takes ~30 sec, 15-min cron = ~2,880 runs/month × 0.5 min = ~1,440 min/month ✅
