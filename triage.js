#!/usr/bin/env node
/**
 * inbox-triage.js
 * ---------------
 * Fetches recent Gmail threads, classifies each with Gemini 2.0 Flash,
 * archives junk, and sends a digest of what's left.
 *
 * Env vars required (set as GitHub Actions secrets):
 *   GMAIL_CLIENT_ID
 *   GMAIL_CLIENT_SECRET
 *   GMAIL_REFRESH_TOKEN
 *   GEMINI_API_KEY
 *   DIGEST_TO_EMAIL        (your gmail address)
 *
 * Optional:
 *   LOOKBACK_HOURS         (default: 1 — set to e.g. 8760 for backfill)
 *   DRY_RUN                (set to "true" to skip archiving/sending)
 */

import { google } from "googleapis";
import fetch from "node-fetch";

// ─── Config ──────────────────────────────────────────────────────────────────

const {
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
  GEMINI_API_KEY,
  DIGEST_TO_EMAIL,
  LOOKBACK_HOURS = "1",
  DRY_RUN = "false",
} = process.env;

const isDryRun = DRY_RUN === "true";
const lookbackMs = parseFloat(LOOKBACK_HOURS) * 60 * 60 * 1000;

// Senders / domains that are ALWAYS kept regardless of AI classification
const ALWAYS_KEEP_PATTERNS = [
  /monarch\.com$/i,
  /igotanoffer\.com$/i,
  /musicologie\.app$/i,
  /gethealthie\.com$/i,
  /parentsquare\.com$/i,
  /ptboard\.com$/i,
  /amazon\.com$/i,
  /accounts\.google\.com$/i,
  /anthropic\.com$/i,
  /github\.com$/i,
  /linkedin\.com$/i,          // job alerts — keep
];

// Senders that are ALWAYS archived (political fundraising spam)
const ALWAYS_ARCHIVE_PATTERNS = [
  /turnoutpac\.org$/i,
  /dccc\.org$/i,
  /chrispappas\.org$/i,
  /harderforcongress\.com$/i,
  /jamestalarico\.com$/i,
];

// ─── Gmail Auth ───────────────────────────────────────────────────────────────

function buildGmailClient() {
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSenderDomain(senderHeader = "") {
  const match = senderHeader.match(/@([\w.-]+)/);
  return match ? match[1].toLowerCase() : "";
}

function isAlwaysKeep(sender) {
  const domain = getSenderDomain(sender);
  return ALWAYS_KEEP_PATTERNS.some((p) => p.test(domain));
}

function isAlwaysArchive(sender) {
  const domain = getSenderDomain(sender);
  return ALWAYS_ARCHIVE_PATTERNS.some((p) => p.test(domain));
}

function extractHeader(headers, name) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Gemini Classification ────────────────────────────────────────────────────

/**
 * Classifies a batch of emails in a single Gemini call.
 * Returns an array of { id, action, summary } objects.
 * action: "keep" | "archive"
 */
async function classifyBatch(emails) {
  const emailList = emails
    .map(
      (e, i) =>
        `[${i}] ID:${e.id}\nFrom: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`
    )
    .join("\n\n");

  const prompt = `You are an expert email triage assistant. Classify each email below as either ARCHIVE or KEEP.

ARCHIVE if the email is:
- Political fundraising, donation requests, or partisan campaign emails (these are spam even if from causes the user supports)
- Pure retail/ecommerce promotions or sales emails (no transactional content like order confirmations)
- Travel deal promotions
- Generic newsletter marketing with no specific personal relevance
- Reward program marketing (Microsoft Rewards, etc.)
- Health/wellness product marketing

KEEP if the email is:
- Personal communication from a real person
- Transactional: order confirmation, delivery update, appointment reminder, billing alert
- Useful automated digest or newsletter with substantive content (tech, news, professional)
- Job alert or career opportunity
- School/community communication about specific events or updates
- Financial or budgeting alerts
- Security alerts from Google/Apple/Microsoft

For each email, respond with exactly this JSON format (array, no markdown):
[
  {"id": "...", "action": "keep|archive", "summary": "One sentence summary for digest (only if keep, else empty string)"}
]

Emails to classify:
${emailList}`;

  const response = await fetch(
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

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";

  // Strip markdown fences if present
  const clean = text.replace(/```json\n?|\n?```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Gmail Operations ─────────────────────────────────────────────────────────

async function archiveThread(gmail, threadId) {
  if (isDryRun) {
    console.log(`[DRY RUN] Would archive thread ${threadId}`);
    return;
  }
  await gmail.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: { removeLabelIds: ["INBOX"] },
  });
}

async function sendDigest(gmail, kept) {
  if (kept.length === 0) {
    console.log("No emails to digest — skipping send.");
    return;
  }

  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const lines = kept
    .map((e) => `• <b>${e.from}</b> — ${e.subject}<br>&nbsp;&nbsp;<i>${e.summary}</i>`)
    .join("<br><br>");

  const html = `
<div style="font-family: Georgia, serif; max-width: 600px; color: #1a1a1a;">
  <h2 style="border-bottom: 2px solid #333; padding-bottom: 8px;">
    📬 Inbox Digest — ${now}
  </h2>
  <p style="color: #555; font-size: 14px;">
    ${kept.length} email${kept.length !== 1 ? "s" : ""} worth your attention:
  </p>
  <br>
  ${lines}
  <br><br>
  <p style="color: #aaa; font-size: 12px;">
    Powered by Gemini 2.0 Flash + GitHub Actions
  </p>
</div>`;

  const subject = `📬 Inbox Digest (${kept.length} emails) — ${now}`;
  const raw = makeRawEmail(DIGEST_TO_EMAIL, DIGEST_TO_EMAIL, subject, html);

  if (isDryRun) {
    console.log(`[DRY RUN] Would send digest to ${DIGEST_TO_EMAIL} with ${kept.length} emails`);
    return;
  }

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  console.log(`✅ Digest sent to ${DIGEST_TO_EMAIL}`);
}

function makeRawEmail(from, to, subject, htmlBody) {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    htmlBody,
  ].join("\r\n");

  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Inbox Triage — lookback: ${LOOKBACK_HOURS}h, dry_run: ${isDryRun}\n`);

  const gmail = buildGmailClient();

  // Fetch threads from lookback window
  const cutoffSec = Math.floor((Date.now() - lookbackMs) / 1000);
  const listRes = await gmail.users.threads.list({
    userId: "me",
    labelIds: ["INBOX"],
    q: `after:${cutoffSec}`,
    maxResults: 200,
  });

  const threads = listRes.data.threads ?? [];
  console.log(`📥 Found ${threads.length} threads in inbox\n`);

  if (threads.length === 0) {
    console.log("Nothing to triage.");
    return;
  }

  // Fetch snippets + headers for each thread
  const emails = [];
  for (const t of threads) {
    try {
      const detail = await gmail.users.threads.get({
        userId: "me",
        id: t.id,
        format: "METADATA",
        metadataHeaders: ["From", "Subject"],
      });
      const msg = detail.data.messages?.[0];
      const headers = msg?.payload?.headers ?? [];
      emails.push({
        id: t.id,
        from: extractHeader(headers, "From"),
        subject: extractHeader(headers, "Subject"),
        snippet: msg?.snippet?.slice(0, 200) ?? "",
      });
    } catch (e) {
      console.warn(`Could not fetch thread ${t.id}: ${e.message}`);
    }
    await sleep(50); // gentle rate limiting
  }

  // Pre-classify with allowlist/blocklist (no AI needed)
  const forAI = [];
  const preKept = [];
  const preArchived = [];

  for (const e of emails) {
    if (isAlwaysKeep(e.from)) {
      preKept.push({ ...e, summary: "(trusted sender — not AI-summarized)" });
    } else if (isAlwaysArchive(e.from)) {
      preArchived.push(e);
    } else {
      forAI.push(e);
    }
  }

  console.log(
    `🏷️  Pre-classified: ${preKept.length} keep, ${preArchived.length} archive, ${forAI.length} → AI\n`
  );

  // Archive pre-classified junk
  for (const e of preArchived) {
    console.log(`🗑️  Archive (blocklist): ${e.from} — ${e.subject}`);
    await archiveThread(gmail, e.id);
    await sleep(100);
  }

  // Run AI classification in batches of 15
  const aiKept = [];
  const aiArchived = [];
  const BATCH = 15;

  for (let i = 0; i < forAI.length; i += BATCH) {
    const batch = forAI.slice(i, i + BATCH);
    console.log(`🤖 Classifying batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(forAI.length / BATCH)} (${batch.length} emails)...`);

    try {
      const results = await classifyBatch(batch);

      // Map results back by id
      const resultMap = Object.fromEntries(results.map((r) => [r.id, r]));

      for (const e of batch) {
        const r = resultMap[e.id];
        if (!r) {
          console.warn(`No classification for ${e.id}, keeping.`);
          aiKept.push({ ...e, summary: "(unclassified — kept by default)" });
          continue;
        }
        if (r.action === "archive") {
          console.log(`🗑️  Archive (AI): ${e.from} — ${e.subject}`);
          aiArchived.push(e);
          await archiveThread(gmail, e.id);
          await sleep(100);
        } else {
          console.log(`✅ Keep: ${e.from} — ${e.subject}`);
          aiKept.push({ ...e, summary: r.summary });
        }
      }
    } catch (err) {
      console.error(`Gemini batch error: ${err.message} — keeping all in batch`);
      for (const e of batch) {
        aiKept.push({ ...e, summary: "(AI error — kept by default)" });
      }
    }

    await sleep(1000); // between batches
  }

  // Compile kept emails (AI-classified only — trusted senders go in separately)
  const digestEmails = [...aiKept];

  // Send digest
  const totalArchived = preArchived.length + aiArchived.length;
  console.log(
    `\n📊 Summary: ${totalArchived} archived, ${digestEmails.length + preKept.length} kept`
  );
  console.log(`📨 Sending digest with ${digestEmails.length} AI-triaged emails...\n`);

  await sendDigest(gmail, digestEmails);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
