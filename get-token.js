/**
 * get-token.js
 * ------------
 * Run this ONCE locally to get your Gmail refresh token.
 * 
 * Usage:
 *   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy node get-token.js
 * 
 * Or edit the values directly below.
 */

import { google } from "googleapis";
import http from "http";
import { URL } from "url";
import open from "open";

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || "PASTE_YOUR_CLIENT_ID_HERE";
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || "PASTE_YOUR_CLIENT_SECRET_HERE";
const REDIRECT_URI = "http://localhost:3000/oauth2callback";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",   // read + archive (remove labels)
  "https://www.googleapis.com/auth/gmail.send",     // send digest
];

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = auth.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent", // forces refresh_token to be returned
});

console.log("\n🔐 Opening browser for Gmail authorization...\n");
console.log("If it doesn't open automatically, visit:\n", authUrl, "\n");

// Try to open browser automatically
try { await open(authUrl); } catch (_) {}

// Spin up a temporary local server to catch the callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3000");
  if (url.pathname !== "/oauth2callback") return;

  const code = url.searchParams.get("code");
  if (!code) {
    res.end("Error: no code in callback");
    server.close();
    return;
  }

  try {
    const { tokens } = await auth.getToken(code);
    res.end("<h2>✅ Authorized! Check your terminal for the refresh token.</h2>");
    server.close();

    console.log("\n✅ Success! Add these to GitHub Secrets:\n");
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("\n(Client ID and Secret come from your OAuth credentials JSON)\n");
  } catch (err) {
    res.end(`Error: ${err.message}`);
    server.close();
    console.error("Token exchange failed:", err);
  }
});

server.listen(3000, () => {
  console.log("Waiting for OAuth callback on http://localhost:3000 ...\n");
});
