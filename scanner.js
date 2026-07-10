/**
 * Insider Signal Scanner
 * ======================
 * Two feeds, one Telegram channel:
 *
 *  FEED 1 — Trump Truth Social monitor (via ScrapeCreators API)
 *    Polls for new posts, keyword-matches against a market-impact dictionary,
 *    and alerts within your polling interval with affected tickers/sectors.
 *
 *  FEED 2 — Congressional trade tracker (via Quiver Quantitative API)
 *    Checks for newly disclosed trades a few times per day, alerts on new
 *    filings, and flags CLUSTER BUYS (3+ members buying the same ticker
 *    within a rolling window) — the strongest signal in this dataset.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *   SCRAPECREATORS_API_KEY   (scrapecreators.com — Truth Social feed)
 *   QUIVER_API_KEY           (quiverquant.com/api — congress trades)
 *   TRUMP_POLL_SECONDS       (default 120 — each poll costs 1 credit)
 *   CONGRESS_POLL_HOURS      (default 4)
 *
 * This aggregates PUBLIC data (posts, mandatory STOCK Act disclosures).
 * It is informational — not financial advice, not a prediction engine.
 */

require("dotenv").config();
const https = require("https");

const CONFIG = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  scrapeCreatorsKey: process.env.SCRAPECREATORS_API_KEY || "",
  quiverKey: process.env.QUIVER_API_KEY || "",
  trumpPollMs: (parseInt(process.env.TRUMP_POLL_SECONDS || "120")) * 1000,
  congressPollMs: (parseInt(process.env.CONGRESS_POLL_HOURS || "4")) * 3600 * 1000,
  clusterWindowDays: 14,   // cluster-buy detection window
  clusterMinMembers: 3,    // members needed to call it a cluster
};

const TRUMP_USER_ID = "107780257626128497"; // @realDonaldTrump

// ─── Market-impact keyword dictionary ────────────────────────────────────────
// keyword (lowercase) → { tickers, note }
const KEYWORD_MAP = [
  { kw: ["tariff", "tariffs", "trade deal", "trade war"], tickers: ["SPY", "QQQ", "FXI", "EWW", "X", "STLD"], note: "Trade policy — broad market + steel/importers", type: "macro" },
  { kw: ["china", "chinese"], tickers: ["FXI", "KWEB", "BABA", "NVDA"], note: "China exposure", type: "sector" },
  { kw: ["crypto", "bitcoin", "digital asset", "strategic reserve"], tickers: ["BTC", "COIN", "MSTR", "MARA", "RIOT"], note: "Crypto policy", type: "sector" },
  { kw: ["drug price", "pharma", "prescription"], tickers: ["XLV", "PFE", "MRK", "LLY", "UNH"], note: "Pharma/healthcare policy", type: "sector" },
  { kw: ["oil", "drill", "energy", "opec", "iran", "hormuz", "strait of hormuz"], tickers: ["CL=F", "USO", "XLE", "XOM", "CVX", "OXY"], note: "Energy/oil — includes crude futures directly", type: "sector" },
  { kw: ["truth social", "trump media", "djt"], tickers: ["DJT"], note: "⚡ Trump's own company — historically moves hard on ANY Trump-related news, even unrelated to the business. Thin float — size small.", type: "ticker" },
  { kw: ["auto", "cars", "ev mandate", "electric vehicle"], tickers: ["TSLA", "F", "GM", "RIVN"], note: "Auto sector", type: "sector" },
  { kw: ["defense", "military", "nato"], tickers: ["ITA", "LMT", "RTX", "NOC"], note: "Defense sector", type: "sector" },
  { kw: ["fed", "powell", "interest rate", "rates"], tickers: ["TLT", "SPY", "GLD", "IWM"], note: "Fed/rates commentary", type: "macro" },
  { kw: ["bank", "banks", "deregulat"], tickers: ["XLF", "JPM", "GS", "BAC"], note: "Financials", type: "sector" },
  { kw: ["immigration", "border"], tickers: ["GEO", "CXW"], note: "Border/detention names", type: "sector" },
  { kw: ["semiconductor", "chips", "taiwan"], tickers: ["SMH", "NVDA", "TSM", "INTC"], note: "Semis", type: "sector" },
  { kw: ["housing", "mortgage"], tickers: ["XHB", "LEN", "DHI"], note: "Housing", type: "sector" },
  { kw: ["steel", "aluminum"], tickers: ["X", "STLD", "NUE", "AA"], note: "Metals", type: "sector" },
  { kw: ["great time to buy", "buy now"], tickers: ["SPY", "QQQ"], note: "⚡ Direct market call — historically significant pattern", type: "macro" },
];

// Instrument guidance by theme type — appended to every market-relevant alert
const INSTRUMENT_GUIDANCE = {
  macro: "📐 *Broad macro post* → consider *SPY/QQQ* (spot) or *MES/MNQ* (micro futures). Avoid single-name options here.",
  sector: "📐 *Sector-themed post* → consider the *sector ETF* (listed above) rather than picking individual names, unless you have a specific conviction.",
  ticker: "📐 *Direct $TICKER mention* → consider that stock directly via *spot shares*. Avoid options — by the time you read this, IV has likely already spiked from the initial algo reaction.",
};


// Also detect explicit $TICKER mentions
const TICKER_RE = /\$([A-Z]{1,5})\b/g;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "InsiderScanner/1.0", ...headers }, timeout: 20000 }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: null, raw: data.slice(0, 200) }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
      console.warn("⚠️  Telegram not configured."); return resolve();
    }
    const body = JSON.stringify({
      chat_id: CONFIG.telegram.chatId,
      text: text.slice(0, 4000),
      parse_mode: "Markdown",
      disable_notification: false,
    });
    const req = https.request(
      `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try { const r = JSON.parse(data); if (!r.ok) console.error("❌ Telegram:", r.description); } catch (e) {}
          resolve();
        });
      }
    );
    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  FEED 1 — Trump Truth Social monitor
// ═══════════════════════════════════════════════════════════════════════════
let lastSeenPostId = null;

function analyzePost(text) {
  const lower = (text || "").toLowerCase();
  const hits = [];

  for (const entry of KEYWORD_MAP) {
    const matched = entry.kw.filter(k => lower.includes(k));
    if (matched.length) hits.push({ matched, tickers: entry.tickers, note: entry.note });
  }

  const explicitTickers = [...(text || "").matchAll(TICKER_RE)].map(m => m[1]);

  return { hits, explicitTickers };
}

async function pollTrump() {
  if (!CONFIG.scrapeCreatorsKey) return;
  try {
    const { status, body } = await httpGetJson(
      `https://api.scrapecreators.com/v1/truthsocial/user/posts?user_id=${TRUMP_USER_ID}`,
      { "x-api-key": CONFIG.scrapeCreatorsKey }
    );
    if (status !== 200 || !body) {
      console.error(`Trump feed: HTTP ${status}`, body?.raw || "");
      return;
    }
    const posts = body.posts || body.data || [];
    if (!posts.length) return;

    // First run: just record the newest post, don't spam history
    if (lastSeenPostId === null) {
      lastSeenPostId = posts[0].id;
      console.log(`🟢 Trump monitor primed at post ${lastSeenPostId}`);
      return;
    }

    // Collect new posts (newest first in feed)
    const newPosts = [];
    for (const p of posts) {
      if (p.id === lastSeenPostId) break;
      newPosts.push(p);
    }
    if (!newPosts.length) return;
    lastSeenPostId = posts[0].id;

    for (const post of newPosts.reverse()) {
      const text = (post.text || post.content || "").replace(/<[^>]+>/g, ""); // strip html
      const { hits, explicitTickers } = analyzePost(text);

      console.log(`📣 New Trump post ${post.id}: ${hits.length} keyword group(s) matched`);

      if (hits.length === 0 && explicitTickers.length === 0) continue; // not market-relevant

      const tickerSet = new Set(explicitTickers);
      const lines = hits.map(h => {
        h.tickers.forEach(t => tickerSet.add(t));
        return `• *${h.note}* (matched: ${h.matched.join(", ")})`;
      });

      // Pick instrument guidance: macro > sector > ticker(-type keyword or
      // explicit $TICKER), in that priority order.
      let guidance;
      if (hits.some(h => h.type === "macro")) {
        guidance = INSTRUMENT_GUIDANCE.macro;
      } else if (hits.some(h => h.type === "sector")) {
        guidance = INSTRUMENT_GUIDANCE.sector;
      } else if (hits.some(h => h.type === "ticker") || explicitTickers.length > 0) {
        guidance = INSTRUMENT_GUIDANCE.ticker;
      }

      const msg =
        `🚨 *TRUMP POST — MARKET RELEVANT* 🚨\n\n` +
        `"${text.slice(0, 500)}${text.length > 500 ? "..." : ""}"\n\n` +
        `*Matched themes:*\n${lines.join("\n")}\n\n` +
        `*Watch tickers:* ${[...tickerSet].map(t => `$${t}`).join(" ")}\n\n` +
        (guidance ? `${guidance}\n\n` : "") +
        `_Posted: ${post.created_at || "just now"}_\n` +
        `_Public post aggregation — not financial advice._`;

      await sendTelegram(msg);
    }
  } catch (e) {
    console.error("Trump poll error:", e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  FEED 2 — Congressional trades tracker
// ═══════════════════════════════════════════════════════════════════════════
const seenTradeKeys = new Set();
const recentBuys = []; // { ticker, rep, date } — for cluster detection

function tradeKey(t) {
  return `${t.Representative}|${t.Ticker}|${t.TransactionDate}|${t.Transaction}|${t.Range}`;
}

async function pollCongress() {
  if (!CONFIG.quiverKey) return;
  try {
    const { status, body } = await httpGetJson(
      "https://api.quiverquant.com/beta/live/congresstrading",
      { "Authorization": `Bearer ${CONFIG.quiverKey}` }
    );
    if (status !== 200 || !Array.isArray(body)) {
      console.error(`Congress feed: HTTP ${status}`, body?.raw || JSON.stringify(body)?.slice(0, 150));
      return;
    }

    const firstRun = seenTradeKeys.size === 0;
    const newTrades = [];

    for (const t of body) {
      const key = tradeKey(t);
      if (!seenTradeKeys.has(key)) {
        seenTradeKeys.add(key);
        if (!firstRun) newTrades.push(t);
        // Track buys for cluster detection regardless
        if ((t.Transaction || "").toLowerCase().includes("purchase")) {
          recentBuys.push({ ticker: t.Ticker, rep: t.Representative, date: t.ReportDate || t.TransactionDate });
        }
      }
    }

    if (firstRun) {
      console.log(`🟢 Congress tracker primed with ${seenTradeKeys.size} known trades`);
      return;
    }
    if (!newTrades.length) return;

    console.log(`🏛️ ${newTrades.length} new congressional trade(s) disclosed`);

    // Group new trades by representative for a compact alert
    const byRep = {};
    for (const t of newTrades) {
      (byRep[t.Representative] = byRep[t.Representative] || []).push(t);
    }

    for (const [rep, trades] of Object.entries(byRep)) {
      const lines = trades.slice(0, 12).map(t =>
        `• ${(t.Transaction || "").includes("Purchase") ? "🟢 BUY" : "🔴 SELL"} $${t.Ticker}  ${t.Range || ""}  _(traded ${t.TransactionDate})_`
      );
      const party = trades[0].Party ? ` (${trades[0].Party.charAt(0)})` : "";
      const msg =
        `🏛️ *CONGRESS TRADE DISCLOSED*\n\n` +
        `*${rep}*${party} — ${trades[0].House || ""}\n\n` +
        lines.join("\n") +
        (trades.length > 12 ? `\n_...and ${trades.length - 12} more_` : "") +
        `\n\n_STOCK Act disclosure (up to 45 days after trade). Public data._`;
      await sendTelegram(msg);
    }

    // Cluster detection: 3+ distinct members buying same ticker within window
    const cutoff = Date.now() - CONFIG.clusterWindowDays * 86400 * 1000;
    const active = recentBuys.filter(b => new Date(b.date).getTime() > cutoff);
    const byTicker = {};
    for (const b of active) {
      (byTicker[b.ticker] = byTicker[b.ticker] || new Set()).add(b.rep);
    }
    for (const [ticker, reps] of Object.entries(byTicker)) {
      if (reps.size >= CONFIG.clusterMinMembers) {
        const clusterKey = `CLUSTER-${ticker}-${[...reps].sort().join(",")}`;
        if (!seenTradeKeys.has(clusterKey)) {
          seenTradeKeys.add(clusterKey);
          await sendTelegram(
            `🔥 *CLUSTER BUY DETECTED* 🔥\n\n` +
            `*$${ticker}* — bought by *${reps.size} members of Congress* within ${CONFIG.clusterWindowDays} days:\n` +
            [...reps].map(r => `• ${r}`).join("\n") +
            `\n\n_Multiple independent buyers is the strongest pattern in this dataset. Still not advice._`
          );
        }
      }
    }

    // Trim memory
    while (recentBuys.length > 5000) recentBuys.shift();
  } catch (e) {
    console.error("Congress poll error:", e.message);
  }
}

async function testTrumpAlert() {
  console.log("🧪 Test mode: fetching latest real post and forcing it through the alert pipeline...");
  if (!CONFIG.scrapeCreatorsKey) {
    console.error("❌ No SCRAPECREATORS_API_KEY set — can't test.");
    return;
  }
  const { status, body } = await httpGetJson(
    `https://api.scrapecreators.com/v1/truthsocial/user/posts?user_id=${TRUMP_USER_ID}`,
    { "x-api-key": CONFIG.scrapeCreatorsKey }
  );
  if (status !== 200 || !body) {
    console.error(`❌ Feed error: HTTP ${status}`, body?.raw || "");
    return;
  }
  const posts = body.posts || body.data || [];
  if (!posts.length) {
    console.error("❌ No posts returned at all.");
    return;
  }

  const post = posts[0]; // most recent real post, regardless of "new" status
  const text = (post.text || post.content || "").replace(/<[^>]+>/g, "");
  const { hits, explicitTickers } = analyzePost(text);

  console.log(`📣 Latest real post: "${text.slice(0, 100)}..."`);
  console.log(`   Matched ${hits.length} keyword group(s), ${explicitTickers.length} explicit ticker(s)`);

  const tickerSet = new Set(explicitTickers);
  const lines = hits.map(h => {
    h.tickers.forEach(t => tickerSet.add(t));
    return `• *${h.note}* (matched: ${h.matched.join(", ")})`;
  });

  let guidance;
  if (hits.some(h => h.type === "macro")) guidance = INSTRUMENT_GUIDANCE.macro;
  else if (hits.some(h => h.type === "sector")) guidance = INSTRUMENT_GUIDANCE.sector;
  else if (hits.some(h => h.type === "ticker") || explicitTickers.length > 0) guidance = INSTRUMENT_GUIDANCE.ticker;

  const msg =
    `🧪 *TEST ALERT* (forced, using your latest real post)\n\n` +
    `"${text.slice(0, 500)}${text.length > 500 ? "..." : ""}"\n\n` +
    (lines.length ? `*Matched themes:*\n${lines.join("\n")}\n\n` : `_No market keywords matched this post — showing anyway since this is a test._\n\n`) +
    (tickerSet.size ? `*Watch tickers:* ${[...tickerSet].map(t => `$${t}`).join(" ")}\n\n` : "") +
    (guidance ? `${guidance}\n\n` : "") +
    `_Posted: ${post.created_at || "unknown"}_\n` +
    `_This is a forced test — the real bot only alerts on genuinely NEW posts._`;

  await sendTelegram(msg);
  console.log("✅ Test alert sent to Telegram — check your group.");
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log("🔍 Debug — raw arguments received:", JSON.stringify(process.argv));
console.log("═══════════════════════════════════════════════════");
console.log("  Insider Signal Scanner");
console.log(`  Feed 1: Trump posts — every ${CONFIG.trumpPollMs / 1000}s ${CONFIG.scrapeCreatorsKey ? "✅" : "❌ (no SCRAPECREATORS_API_KEY)"}`);
console.log(`  Feed 2: Congress trades — every ${CONFIG.congressPollMs / 3600000}h ${CONFIG.quiverKey ? "✅" : "❌ (no QUIVER_API_KEY)"}`);
console.log("═══════════════════════════════════════════════════");

pollTrump();
pollCongress();

if (process.argv.includes("--test-trump")) {
  testTrumpAlert();
} else {
  setInterval(pollTrump, CONFIG.trumpPollMs);
  setInterval(pollCongress, CONFIG.congressPollMs);
}
