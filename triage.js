#!/usr/bin/env node
/**
 * inbox-triage.js — 3-tier version
 * Tiers: inbox (action needed) | digest (FYI, archived) | archive (junk)
 */

import { google } from "googleapis";
import fetch from "node-fetch";

const {
  GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
  GEMINI_API_KEY, DIGEST_TO_EMAIL,
  LOOKBACK_HOURS = "1", DRY_RUN = "false", SEND_DIGEST = "false",
} = process.env;

const isDryRun = DRY_RUN === "true";
const isSendDigest = SEND_DIGEST === "true";
const lookbackMs = parseFloat(LOOKBACK_HOURS) * 60 * 60 * 1000;

// Pre-classified as DIGEST (useful, no action, remove from inbox)
const ALWAYS_DIGEST_PATTERNS = [
  { pattern: /monarch\.com$/i, category: "Finance" },
  { pattern: /musicologie\.app$/i, category: "Appointments" },
  { pattern: /parentsquare\.com$/i, category: "School" },
  { pattern: /ptboard\.com$/i, category: "School" },
  { pattern: /amazon\.com$/i, category: "Finance" },
  { pattern: /accounts\.google\.com$/i, category: "Other" },
  { pattern: /linkedin\.com$/i, category: "Job Alerts" },
  { pattern: /substack\.com$/i, category: "News & Newsletters" },
  { pattern: /politico\.com$/i, category: "News & Newsletters" },
  { pattern: /nextdoor\.com$/i, category: "News & Newsletters" },
  { pattern: /ifttt\.com$/i, category: "Other" },
  { pattern: /infoemail\.microsoft\.com$/i, category: "Other" },
  { pattern: /customeremail\.microsoftrewards\.com$/i, category: "Other" },
];

// Pre-classified as INBOX (always high signal, keep in inbox)
const ALWAYS_INBOX_PATTERNS = [
  /igotanoffer\.com$/i,
  /gethealthie\.com$/i,
  /anthropic\.com$/i,
  /github\.com$/i,
];

// Always archived without AI
const ALWAYS_ARCHIVE_PATTERNS = [
  /turnoutpac\.org$/i,
  /dccc\.org$/i,
  /ak\.dccc\.org$/i,
  /chrispappas\.org$/i,
  /harderforcongress\.com$/i,
  /jamestalarico\.com$/i,
  /polymarket\.com$/i,
];

function buildGmailClient() {
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

function getSenderDomain(s = "") {
  const m = s.match(/@([\w.-]+)/);
  return m ? m[1].toLowerCase() : "";
}

function preClassify(sender) {
  const d = getSenderDomain(sender);
  if (ALWAYS_ARCHIVE_PATTERNS.some((p) => p.test(d))) return { tier: "archive" };
  if (ALWAYS_INBOX_PATTERNS.some((p) => p.test(d))) return { tier: "inbox" };
  const match = ALWAYS_DIGEST_PATTERNS.find(({ pattern }) => pattern.test(d));
  if (match) return { tier: "digest", category: match.category };
  return null;
}

function extractHeader(headers, name) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function classifyBatch(emails) {
  const list = emails
    .map((e, i) => `[${i}] ID:${e.id}\nFrom: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`)
    .join("\n\n");

  const prompt = `You are triaging email for MJ, a product manager. Classify each email into one of three tiers:

INBOX — requires MJ to DO something or RESPOND to someone. A real human is waiting or inaction has a consequence. Calendar invites needing a response, direct messages from colleagues, job interview scheduling, doctor/appointment follow-ups. Be very strict — when in doubt, do NOT put in INBOX.

DIGEST — useful information MJ would genuinely want to know: account activity (bank/investment alerts, shipping confirmations for recent orders), school/family updates, legitimate job opportunities, appointment confirmations, utility bills, government correspondence. Must have real informational value.

ARCHIVE — everything else. This is the DEFAULT for any uncertainty. Archive: marketing emails, promotional offers, sale announcements, travel deals, hotel/airline promos, reward points, subscription upsells, event invitations from companies, newsletters from brands (not publications MJ subscribed to intentionally), social network digests, "we miss you" re-engagement emails, app activity summaries, any "unsubscribe" footer email that isn't in DIGEST.

Bias heavily toward ARCHIVE. If an email is not clearly INBOX or clearly DIGEST, it is ARCHIVE.

For DIGEST emails, assign one category from: Appointments, Finance, School, Job Alerts, News & Newsletters, Other.

Return ONLY a JSON array, no markdown:
[{"id":"...","tier":"inbox|digest|archive","category":"(only for digest tier)","summary":"One sentence (inbox: what action needed; digest: what happened; archive: empty string)"}]

Emails:
${list}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  return JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim());
}

async function archiveThread(gmail, id) {
  if (isDryRun) { console.log(`[DRY RUN] archive ${id}`); return; }
  try {
    await gmail.users.threads.modify({ userId: "me", id, requestBody: { removeLabelIds: ["INBOX"] } });
  } catch (e) {
    console.warn(`  ⚠️  Failed to archive ${id}: ${e.message}`);
  }
}

const DIGEST_CATEGORY_ORDER = ["Appointments", "Finance", "School", "Job Alerts", "News & Newsletters", "Other"];

function row(e) {
  const from = e.from.replace(/<.*?>/, "").trim();
  const link = `https://mail.google.com/mail/u/0/#all/${e.id}`;
  return `<tr><td style="padding:10px 0;border-bottom:1px solid #eee;vertical-align:top;">
    <a href="${link}" style="text-decoration:none;color:inherit;"><b>${from}</b> — ${e.subject}</a><br>
    <span style="color:#666;font-size:13px;">${e.summary}</span>
  </td></tr>`;
}

function groupedDigestHtml(digest) {
  if (!digest.length) return "";
  const groups = {};
  for (const e of digest) {
    const cat = e.category || "Other";
    (groups[cat] = groups[cat] || []).push(e);
  }
  const sections = DIGEST_CATEGORY_ORDER.filter((c) => groups[c])
    .concat(Object.keys(groups).filter((c) => !DIGEST_CATEGORY_ORDER.includes(c)));
  return sections.map((cat) => `
    <h4 style="color:#777;margin:20px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:1px;">${cat}</h4>
    <table style="width:100%;border-collapse:collapse;">${groups[cat].map(row).join("")}</table>`).join("");
}

async function sendDigest(gmail, inbox, digest) {
  const total = inbox.length + digest.length;
  if (total === 0) { console.log("Nothing to digest."); return; }

  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });

  const inboxHtml = inbox.length ? `
    <h3 style="color:#c0392b;margin:24px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:1px;">⚡ Needs Attention (${inbox.length})</h3>
    <table style="width:100%;border-collapse:collapse;">${inbox.map(row).join("")}</table>` : "";

  const digestHtml = digest.length ? `
    <h3 style="color:#555;margin:24px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:1px;">📋 FYI (${digest.length})</h3>
    ${groupedDigestHtml(digest)}` : "";

  const html = `<div style="font-family:-apple-system,Georgia,serif;max-width:620px;color:#1a1a1a;padding:0 16px;">
  <div style="border-bottom:3px solid #1a1a1a;padding-bottom:12px;margin-bottom:4px;">
    <h2 style="margin:0;font-size:20px;">📬 Inbox Digest</h2>
    <p style="margin:4px 0 0;color:#888;font-size:13px;">${now} · ${total} email${total !== 1 ? "s" : ""}</p>
  </div>
  ${inboxHtml}${digestHtml}
  <p style="color:#ccc;font-size:11px;margin-top:32px;">Gemini 2.0 Flash + GitHub Actions</p>
</div>`;

  const subject = inbox.length
    ? `📬 ${inbox.length} need attention, ${digest.length} FYI — ${now}`
    : `📋 Digest (${digest.length} FYI) — ${now}`;

  const encodedSubject = `=?utf-8?b?${Buffer.from(subject).toString("base64")}?=`;
  const msg = [`From: ${DIGEST_TO_EMAIL}`, `To: ${DIGEST_TO_EMAIL}`, `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`, `Content-Type: text/html; charset=utf-8`, ``, html].join("\r\n");
  const raw = Buffer.from(msg).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  if (isDryRun) { console.log(`[DRY RUN] digest: ${inbox.length} inbox, ${digest.length} FYI`); return; }
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(`✅ Digest sent — ${inbox.length} inbox, ${digest.length} FYI`);
}

async function main() {
  console.log(`\n🔍 Triage — lookback: ${LOOKBACK_HOURS}h, dry_run: ${isDryRun}\n`);
  const gmail = buildGmailClient();

  const cutoff = Math.floor((Date.now() - lookbackMs) / 1000);
  const listRes = await gmail.users.threads.list({ userId: "me", labelIds: ["INBOX"], q: `after:${cutoff}`, maxResults: 200 });
  const threads = listRes.data.threads ?? [];
  console.log(`📥 ${threads.length} threads\n`);
  if (!threads.length) return;

  const emails = [];
  for (const t of threads) {
    try {
      const d = await gmail.users.threads.get({ userId: "me", id: t.id, format: "METADATA", metadataHeaders: ["From", "Subject"] });
      const msg = d.data.messages?.[0];
      const h = msg?.payload?.headers ?? [];
      emails.push({ id: t.id, from: extractHeader(h, "From"), subject: extractHeader(h, "Subject"), snippet: msg?.snippet?.slice(0, 200) ?? "" });
    } catch (e) { console.warn(`Skip ${t.id}: ${e.message}`); }
    await sleep(50);
  }

  const forAI = [], preInbox = [], preDigest = [], preArchive = [];
  for (const e of emails) {
    const pre = preClassify(e.from);
    if (!pre) { forAI.push(e); continue; }
    if (pre.tier === "archive") preArchive.push(e);
    else if (pre.tier === "inbox") preInbox.push({ ...e, summary: "(see email)" });
    else if (pre.tier === "digest") preDigest.push({ ...e, category: pre.category, summary: e.snippet?.slice(0, 100) ?? "" });
  }

  console.log(`🏷️  Pre: ${preInbox.length} inbox, ${preDigest.length} digest, ${preArchive.length} archive, ${forAI.length} → AI\n`);

  for (const e of preArchive) { console.log(`🗑️  ${e.from} — ${e.subject}`); await archiveThread(gmail, e.id); await sleep(100); }
  for (const e of preDigest) { console.log(`📋 ${e.from} — ${e.subject}`); await archiveThread(gmail, e.id); await sleep(100); }

  const aiInbox = [], aiDigest = [];
  for (let i = 0; i < forAI.length; i += 15) {
    const batch = forAI.slice(i, i + 15);
    console.log(`\n🤖 Batch ${Math.floor(i/15)+1}/${Math.ceil(forAI.length/15)} (${batch.length})...`);
    try {
      const results = await classifyBatch(batch);
      const map = Object.fromEntries(results.map((r) => [r.id, r]));
      for (const e of batch) {
        const r = map[e.id];
        if (!r) { aiInbox.push({ ...e, summary: "(unclassified)" }); continue; }
        if (r.tier === "archive") { console.log(`🗑️  ${e.from} — ${e.subject}`); await archiveThread(gmail, e.id); await sleep(100); }
        else if (r.tier === "digest") { console.log(`📋 [${r.category || "Other"}] ${e.from} — ${e.subject}`); aiDigest.push({ ...e, summary: r.summary, category: r.category || "Other" }); await archiveThread(gmail, e.id); await sleep(100); }
        else { console.log(`⚡ ${e.from} — ${e.subject}`); aiInbox.push({ ...e, summary: r.summary }); }
      }
    } catch (err) {
      console.error(`Gemini error: ${err.message}`);
      for (const e of batch) aiInbox.push({ ...e, summary: "(AI error)" });
    }
    await sleep(1000);
  }

  const allInbox = [...preInbox, ...aiInbox];
  const allDigest = [...preDigest, ...aiDigest];
  console.log(`\n📊 ${allInbox.length} inbox, ${allDigest.length} digest`);
  if (isSendDigest) {
    await sendDigest(gmail, allInbox, allDigest);
  } else {
    console.log("📭 Digest suppressed (archive-only run).");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
