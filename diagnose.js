const fs    = require("fs");
const http  = require("http");
const https = require("https");
const axios = require("axios");
const cheerio = require("cheerio");

const urls = fs
  .readFileSync("urls.txt", "utf-8")
  .split("\n").map(u => u.trim()).filter(Boolean)
  .slice(0, 30);

const SEL_WRAPPER = ".swiper-wrapper.top-articles__items";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];
let uai = 0;

const agent = new https.Agent({ keepAlive: true, maxSockets: 60 });

async function check(url, concLevel) {
  try {
    const res = await axios.get(url, {
      timeout: 12000,
      httpsAgent: agent,
      httpAgent: new http.Agent({ keepAlive: true }),
      decompress: true,
      headers: {
        "User-Agent": USER_AGENTS[uai++ % USER_AGENTS.length],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    const $ = cheerio.load(res.data);
    const found = $(SEL_WRAPPER).length > 0;
    const kb = Math.round(Buffer.byteLength(res.data, "utf8") / 1024);

    // If missing, check what swiper classes DO exist
    let altClasses = "";
    if (!found) {
      const classes = [];
      $("[class]").each((i, el) => {
        const c = $(el).attr("class") || "";
        if (c.includes("swiper-wrapper")) classes.push(c.trim());
      });
      altClasses = [...new Set(classes)].slice(0, 3).join(" | ") || "no swiper-wrapper at all";
    }

    return { found, kb, altClasses, url };
  } catch (e) {
    return { found: false, kb: 0, altClasses: `ERROR: ${e.message.slice(0,40)}`, url };
  }
}

async function runAtConcurrency(level) {
  let idx = 0, found = 0, missing = 0;
  const sample = urls.slice(0, 20);

  async function worker() {
    while (idx < sample.length) {
      const url = sample[idx++];
      const r = await check(url, level);
      if (r.found) {
        found++;
      } else {
        missing++;
        console.log(`  MISS [conc=${level}] ${r.kb}KB — ${r.altClasses} — ...${url.slice(-40)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: level }, () => worker()));
  return { found, missing };
}

(async () => {
  console.log("\n=== Testing concurrency=1 (sequential) ===");
  const r1 = await runAtConcurrency(1);
  console.log(`Found: ${r1.found}/20  Missing: ${r1.missing}/20`);

  console.log("\n=== Testing concurrency=10 ===");
  const r10 = await runAtConcurrency(10);
  console.log(`Found: ${r10.found}/20  Missing: ${r10.missing}/20`);

  console.log("\n=== Testing concurrency=50 ===");
  const r50 = await runAtConcurrency(50);
  console.log(`Found: ${r50.found}/20  Missing: ${r50.missing}/20`);

  console.log("\n====== CONCLUSION ======");
  if (r1.missing === 0 && r50.missing > 5) {
    console.log("CONFIRMED: Server returns incomplete HTML under load.");
    console.log("The swiper section is stripped when server detects concurrent requests.");
    console.log("Fix: reduce concurrency to 10-15 OR the section needs Playwright always.");
  } else if (r1.missing > 5) {
    console.log("The swiper section is NOT in static HTML at all — needs Playwright for most URLs.");
    console.log("Fix: skip Cheerio fast path, go straight to Playwright for all URLs.");
    console.log("Increase PLAYWRIGHT_POOL_SIZE to 30-40 for speed.");
  } else {
    console.log("Cheerio works at low concurrency. Tune CONCURRENT_WORKERS down to 10-15.");
  }
})();