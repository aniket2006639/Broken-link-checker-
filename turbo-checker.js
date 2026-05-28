const fs             = require("fs");
const http           = require("http");
const https          = require("https");
const axios          = require("axios");
const cheerio        = require("cheerio");
const { chromium }   = require("playwright-extra");
const StealthPlugin  = require("puppeteer-extra-plugin-stealth")();
const createCsvWriter = require("csv-writer").createObjectCsvWriter;

chromium.use(StealthPlugin);

/*
==================================================
  CONFIG
==================================================
*/
const CONFIG = {
  // — Playwright —
  PLAYWRIGHT_POOL_SIZE:  15,
  PLAYWRIGHT_TIMEOUT:    30000,
  SELECTOR_TIMEOUT:      3000,   // reduced from 8s — saves 5s per missing section
  HEADLESS:              true,

  // — Cheerio (fast path) —
  CHEERIO_ENABLED:       true,
  CHEERIO_CONCURRENCY:   20,
  AXIOS_TIMEOUT:         12000,

  // — Retries —
  RETRY_COUNT:           2,
};

/*
==================================================
  SELECTORS
==================================================
*/
const SEL_WRAPPER = ".swiper-wrapper.top-articles__items";
const SEL_CARD    = "a.swiper-slide.items-wrapper";
const SEL_TITLE   = ".items-container__title";

/*
==================================================
  USER AGENTS
==================================================
*/
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];
let uaIdx = 0;
function nextUA() { return USER_AGENTS[uaIdx++ % USER_AGENTS.length]; }

/*
==================================================
  HELPERS
==================================================
*/
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/*
==================================================
  AXIOS — keep-alive connection pool
==================================================
*/
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 30 });
const httpAgent  = new http.Agent({  keepAlive: true, maxSockets: 30 });

const axiosInstance = axios.create({
  timeout:     CONFIG.AXIOS_TIMEOUT,
  httpsAgent,
  httpAgent,
  decompress:  true,
  headers: {
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control":   "no-cache",
    "Connection":      "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  },
});

/*
==================================================
  READ & DEDUPLICATE URLS
==================================================
*/
const allUrls = fs
  .readFileSync("urls.txt", "utf-8")
  .split("\n")
  .map(u => u.trim())
  .filter(Boolean);

const uniqueUrls = [...new Set(allUrls)];

const urlIndexMap = new Map();
uniqueUrls.forEach(u => urlIndexMap.set(u, []));
allUrls.forEach((u, i) => {
  if (urlIndexMap.has(u)) urlIndexMap.get(u).push(i);
});

/*
==================================================
  SHARED STATE
==================================================
*/
const resultsByUrl    = new Map();
let processed         = 0;
let cheerioHits       = 0;
let playwrightHits    = 0;
let cheerioAttempts   = 0;
let skippedDuplicates = allUrls.length - uniqueUrls.length;
const startTime       = Date.now();

/*
==================================================
  CHEERIO FAST PATH
==================================================
*/
async function tryCheerio(url) {
  cheerioAttempts++;
  try {
    const { data } = await axiosInstance.get(url, {
      headers: { "User-Agent": nextUA() },
    });
    const $ = cheerio.load(data);
    const wrapper = $(SEL_WRAPPER);
    if (!wrapper.length) return null;

    const cards = [];
    wrapper.find(SEL_CARD).each((i, el) => {
      const card = $(el);
      cards.push({
        index:  i + 1,
        href:   card.attr("href")?.trim()            || "",
        imgSrc: card.find("img").attr("src")?.trim() || "",
        title:  card.find(SEL_TITLE).text().trim()   || "",
      });
    });
    return cards;
  } catch {
    return null;
  }
}

/*
==================================================
  PLAYWRIGHT BROWSER MANAGER
==================================================
*/
let _browser = null;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: CONFIG.HEADLESS,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--no-first-run",
    ],
  });
  return _browser;
}

async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }
}

/*
==================================================
  SEMAPHORE
==================================================
*/
class Semaphore {
  constructor(max) {
    this._max     = max;
    this._count   = 0;
    this._waiting = [];
  }
  async acquire() {
    if (this._count < this._max) { this._count++; return; }
    return new Promise(resolve => this._waiting.push(resolve));
  }
  release() {
    if (this._waiting.length > 0) { this._waiting.shift()(); }
    else { this._count--; }
  }
}

const playwrightSem = new Semaphore(CONFIG.PLAYWRIGHT_POOL_SIZE);

/*
==================================================
  PLAYWRIGHT EXTRACTION
==================================================
*/
async function tryPlaywright(url, timeout = CONFIG.PLAYWRIGHT_TIMEOUT) {
  await playwrightSem.acquire();
  let context = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      viewport:   { width: 1920, height: 1080 },
      locale:     "en-IN",
      timezoneId: "Asia/Kolkata",
      userAgent:  nextUA(),
    });

    const page = await context.newPage();
    await page.route("**/*", route => {
      const t = route.request().resourceType();
      if (["image", "font", "media", "stylesheet"].includes(t)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    try {
      await page.waitForSelector(SEL_WRAPPER, { timeout: CONFIG.SELECTOR_TIMEOUT });
    } catch {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (bodyText.includes("Access Denied")) {
        return { cards: null, error: "Blocked by CDN" };
      }
      return { cards: null, error: "Articles section missing (timeout)" };
    }

    const cards = await page.evaluate(
      ({ SEL_WRAPPER, SEL_CARD, SEL_TITLE }) => {
        const wrapper = document.querySelector(SEL_WRAPPER);
        if (!wrapper) return null;
        return Array.from(wrapper.querySelectorAll(SEL_CARD)).map((card, i) => ({
          index:  i + 1,
          href:   card.getAttribute("href")?.trim()                      || "",
          imgSrc: card.querySelector("img")?.getAttribute("src")?.trim() || "",
          title:  card.querySelector(SEL_TITLE)?.textContent?.trim()     || "",
        }));
      },
      { SEL_WRAPPER, SEL_CARD, SEL_TITLE }
    );

    if (cards === null) {
      return { cards: null, error: "Articles section missing" };
    }
    return { cards, error: null };

  } catch (err) {
    return { cards: null, error: err.message };
  } finally {
    if (context) { try { await context.close(); } catch {} }
    playwrightSem.release();
  }
}

/*
==================================================
  PROGRESS LOGGING
==================================================
*/
function logProgress() {
  if (processed % 10 === 0 || processed === uniqueUrls.length) {
    const elapsed    = (Date.now() - startTime) / 1000;
    const uniqueRate = Math.round(processed / elapsed * 60);
    const effRate    = Math.round((processed / uniqueUrls.length * allUrls.length) / elapsed * 60);
    const failCount  = [...resultsByUrl.values()].filter(r => r.error).length;
    console.log(
      `  → ${processed}/${uniqueUrls.length} unique  |  ` +
      `${uniqueRate} unique/min  |  ~${effRate} effective/min  |  ` +
      `cheerio:${cheerioHits}  playwright:${playwrightHits}  failed:${failCount}`
    );
  }
}

/*
==================================================
  PARALLEL RUNNER — no delay between requests
==================================================
*/
async function runParallel(items, workerFn, concurrency) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      await workerFn(items[idx++]);
    }
  }
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/*
==================================================
  VALIDATE CARDS & BUILD RESULTS
==================================================
*/
function buildFinalResults() {
  const failedResults = [];
  let totalCards  = 0;
  let brokenCards = 0;

  for (const url of allUrls) {
    const result = resultsByUrl.get(url);
    if (!result) {
      failedResults.push({ url, card: "-", issue: "Not processed" });
      continue;
    }
    if (result.error) {
      failedResults.push({ url, card: "-", issue: result.error });
      continue;
    }
    if (!result.cards || result.cards.length === 0) {
      failedResults.push({ url, card: "-", issue: "No cards found" });
      continue;
    }
    for (const card of result.cards) {
      totalCards++;
      const issues = [];
      if (!card.href)   issues.push("Missing href");
      if (!card.imgSrc) issues.push("Missing image src");
      if (!card.title)  issues.push("Empty title");
      if (issues.length > 0) {
        brokenCards++;
        failedResults.push({ url, card: card.index, issue: issues.join(", ") });
      }
    }
  }
  return { failedResults, totalCards, brokenCards };
}

/*
==================================================
  MAIN
==================================================
*/
(async () => {
  console.log("\n  ⚡ TURBO ARTICLE VALIDATOR\n");
  console.log(`  Total URLs in file  : ${allUrls.length}`);
  console.log(`  Unique URLs         : ${uniqueUrls.length}`);
  console.log(`  Duplicates skipped  : ${skippedDuplicates}`);
  console.log(`  Cheerio fast-path   : ${CONFIG.CHEERIO_ENABLED ? "ON" : "OFF"}`);
  console.log(`  Playwright pool     : ${CONFIG.PLAYWRIGHT_POOL_SIZE} pages`);
  console.log(`  Page timeout        : ${CONFIG.PLAYWRIGHT_TIMEOUT / 1000}s`);
  console.log(`  Selector timeout    : ${CONFIG.SELECTOR_TIMEOUT / 1000}s`);
  console.log(`  Max retries         : ${CONFIG.RETRY_COUNT}`);
  console.log(`  UA rotation         : ${USER_AGENTS.length} agents\n`);

  // Warm-up
  console.log("  ── Warming up: testing connectivity ──");
  const testUrl = uniqueUrls[0];
  try {
    const { status } = await axiosInstance.get(testUrl, {
      headers: { "User-Agent": nextUA() },
      timeout: 10000,
    });
    console.log(`  ✓ ${testUrl} → HTTP ${status}\n`);
  } catch (e) {
    console.log(`  ⚠ Warm-up fetch failed: ${e.message}`);
    console.log(`  Continuing anyway — Playwright may succeed...\n`);
  }

  // Phase 1 — Cheerio
  if (CONFIG.CHEERIO_ENABLED) {
    console.log("  ── Phase 1: Cheerio fast-path ──");
    await runParallel(uniqueUrls, async (url) => {
      const cards = await tryCheerio(url);
      if (cards !== null) {
        cheerioHits++;
        resultsByUrl.set(url, { cards, error: null });
        processed++;
        logProgress();
      }
    }, CONFIG.CHEERIO_CONCURRENCY);

    const remaining = uniqueUrls.filter(u => !resultsByUrl.has(u));
    console.log(`\n  Cheerio resolved    : ${cheerioHits}/${uniqueUrls.length}`);
    console.log(`  Need Playwright     : ${remaining.length}\n`);

    // Phase 2 — Playwright (no retries, no delay)
    if (remaining.length > 0) {
      console.log("  ── Phase 2: Playwright fallback ──");
      console.log(`  Using ${CONFIG.PLAYWRIGHT_POOL_SIZE} concurrent tabs\n`);

      await runParallel(remaining, async (url) => {
        playwrightHits++;
        let result = null;

        for (let attempt = 1; attempt <= CONFIG.RETRY_COUNT; attempt++) {
          if (attempt > 1) {
            await sleep(2000 * (attempt - 1));
          }
          const timeout = CONFIG.PLAYWRIGHT_TIMEOUT + (attempt - 1) * 10000;
          result = await tryPlaywright(url, timeout);
          if (!result.error) break;
          if (result.error === "Blocked by CDN" || result.error === "Articles section missing" || result.error === "Articles section missing (timeout)") break;
        }

        resultsByUrl.set(url, result);
        processed++;
        logProgress();
      }, CONFIG.PLAYWRIGHT_POOL_SIZE);
    }
  } else {
    console.log("  ── Playwright-only mode ──");
    await runParallel(uniqueUrls, async (url) => {
      playwrightHits++;
      const result = await tryPlaywright(url);
      resultsByUrl.set(url, result);
      processed++;
      logProgress();
    }, CONFIG.PLAYWRIGHT_POOL_SIZE);
  }

  await closeBrowser();

  const { failedResults, totalCards, brokenCards } = buildFinalResults();

  const csvWriter = createCsvWriter({
    path: "broken-article-cards-report.csv",
    header: [
      { id: "url",   title: "URL"         },
      { id: "card",  title: "BROKEN_CARD" },
      { id: "issue", title: "ISSUE"       },
    ],
  });
  await csvWriter.writeRecords(failedResults);

  const totalSec = (Date.now() - startTime) / 1000;
  const speed    = (allUrls.length / totalSec).toFixed(2);

  console.log("\n====================================");
  console.log("✅  COMPLETED");
  console.log("====================================");
  console.log(`  Total URLs (file)   : ${allUrls.length}`);
  console.log(`  Unique URLs         : ${uniqueUrls.length}`);
  console.log(`  Duplicates skipped  : ${skippedDuplicates}`);
  console.log(`  Total cards found   : ${totalCards}`);
  console.log(`  Broken cards        : ${brokenCards}`);
  console.log(`  Failed/missing URLs : ${failedResults.filter(r => r.card === "-").length}`);
  console.log(`  Cheerio hits        : ${cheerioHits} (${Math.round(cheerioHits/uniqueUrls.length*100)}%)`);
  console.log(`  Playwright hits     : ${playwrightHits} (${Math.round(playwrightHits/uniqueUrls.length*100)}%)`);
  console.log(`  Time                : ${totalSec.toFixed(2)}s`);
  console.log(`  Speed               : ${speed} URLs/sec`);
  console.log(`  Rate                : ${Math.round(speed * 60)} URLs/min`);
  console.log("\n📄  broken-article-cards-report.csv\n");
})();