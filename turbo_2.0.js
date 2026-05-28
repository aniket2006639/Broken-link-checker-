const fs = require("fs");
const http = require("http");
const https = require("https");
const axios = require("axios");
const cheerio = require("cheerio");
const pLimit = require("p-limit").default;

const createCsvWriter =
  require("csv-writer").createObjectCsvWriter;

/*
==================================================
CONFIG
==================================================
*/

const CONFIG = {
  CONCURRENCY: 200,
  TIMEOUT: 4000,
  LOG_EVERY: 200,
};

/*
==================================================
SELECTORS
==================================================
*/

const SEL_WRAPPER =
  ".swiper-wrapper.top-articles__items";

const SEL_CARD =
  "a.swiper-slide.items-wrapper";

const SEL_TITLE =
  ".items-container__title";

/*
==================================================
USER AGENTS
==================================================
*/

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36",

  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",

  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

let uaIndex = 0;

function nextUA() {
  return USER_AGENTS[
    uaIndex++ % USER_AGENTS.length
  ];
}

/*
==================================================
KEEP ALIVE
==================================================
*/

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 150,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 150,
});

/*
==================================================
AXIOS INSTANCE
==================================================
*/

const axiosInstance = axios.create({
  timeout: CONFIG.TIMEOUT,

  httpAgent,
  httpsAgent,

  decompress: true,

  headers: {
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

    "Accept-Language":
      "en-IN,en;q=0.9",

    Connection: "keep-alive",
  },
});

/*
==================================================
READ URLS
==================================================
*/

const allUrls = fs
  .readFileSync("urls.txt", "utf-8")
  .split("\n")
  .map((u) => u.trim())
  .filter(Boolean);

const uniqueUrls = [...new Set(allUrls)];

/*
==================================================
CONSOLE INFO
==================================================
*/

console.log(
  "\n⚡ FAST DEFECT URL CHECKER\n"
);

console.log(
  `Total URLs    : ${allUrls.length}`
);

console.log(
  `Unique URLs   : ${uniqueUrls.length}`
);

console.log(
  `Concurrency   : ${CONFIG.CONCURRENCY}\n`
);

/*
==================================================
SHARED STATE
==================================================
*/

const brokenUrls = [];

let processed = 0;

const startTime = Date.now();

/*
==================================================
CHECK URL
==================================================
*/

async function checkUrl(url) {

  try {

    const response =
      await axiosInstance.get(url, {
        headers: {
          "User-Agent": nextUA(),
        },
      });

    const data = response.data;

    /*
    ==================================================
    FAST PRECHECK
    ==================================================
    */

    if (
      !data.includes(
        "top-articles__items"
      )
    ) {

      brokenUrls.push({ url });

      return;
    }

    /*
    ==================================================
    LOAD CHEERIO
    ==================================================
    */

    const $ = cheerio.load(data);

    const wrapper = $(SEL_WRAPPER);

    if (!wrapper.length) {

      brokenUrls.push({ url });

      return;
    }

    const cards =
      wrapper.find(SEL_CARD);

    if (!cards.length) {

      brokenUrls.push({ url });

      return;
    }

    /*
    ==================================================
    EARLY EXIT VALIDATION
    ==================================================
    */

    let defective = false;

    cards.each((i, el) => {

      if (defective)
        return false;

      const card = $(el);

      /*
      ----------------------------------------------
      CHECK HREF
      ----------------------------------------------
      */

      const href =
        card.attr("href");

      if (!href) {

        defective = true;

        return false;
      }

      /*
      ----------------------------------------------
      CHECK IMAGE
      ----------------------------------------------
      */

      const img =
        card.find("img")
          .attr("src");

      if (!img) {

        defective = true;

        return false;
      }

      /*
      ----------------------------------------------
      CHECK TITLE
      ----------------------------------------------
      */

      const title =
        card.find(SEL_TITLE)
          .text()
          .trim();

      if (!title) {

        defective = true;

        return false;
      }
    });

    /*
    ==================================================
    SAVE ONLY BROKEN URL
    ==================================================
    */

    if (defective) {

      brokenUrls.push({ url });
    }

  } catch {

    /*
    ==================================================
    REQUEST FAILED
    ==================================================
    */

    brokenUrls.push({ url });

  } finally {

    processed++;

    /*
    ==================================================
    PROGRESS
    ==================================================
    */

    if (
      processed %
        CONFIG.LOG_EVERY ===
        0 ||

      processed ===
        uniqueUrls.length
    ) {

      const elapsed =
        (Date.now() -
          startTime) /
        1000;

      const speed =
        processed / elapsed;

      const eta =
        (uniqueUrls.length -
          processed) /
        speed;

      console.log(
        `Processed: ${processed}/${uniqueUrls.length} | ` +
        `Speed: ${speed.toFixed(
          2
        )} URLs/sec | ` +
        `Rate: ${Math.round(
          speed * 60
        )} URLs/min | ` +
        `ETA: ${eta.toFixed(
          1
        )}s`
      );
    }
  }
}

/*
==================================================
MAIN
==================================================
*/

(async () => {

  const limit =
    pLimit(CONFIG.CONCURRENCY);

  await Promise.all(

    uniqueUrls.map((url) =>

      limit(() =>
        checkUrl(url)
      )
    )
  );

  /*
  ==================================================
  CSV EXPORT
  ==================================================
  */

  const csvWriter =
    createCsvWriter({

      path:
        "broken-urls-report.csv",

      header: [
        {
          id: "url",
          title: "URL",
        },
      ],
    });

  await csvWriter.writeRecords(
    brokenUrls
  );

  /*
  ==================================================
  FINAL STATS
  ==================================================
  */

  const totalTime = (
    (Date.now() -
      startTime) /
    1000
  ).toFixed(2);

  const finalSpeed = (
    uniqueUrls.length /
    totalTime
  ).toFixed(2);

  console.log(
    "\n=================================="
  );

  console.log(
    "✅ COMPLETED"
  );

  console.log(
    "=================================="
  );

  console.log(
    `Total URLs      : ${allUrls.length}`
  );

  console.log(
    `Unique URLs     : ${uniqueUrls.length}`
  );

  console.log(
    `Broken URLs     : ${brokenUrls.length}`
  );

  console.log(
    `Time Taken      : ${totalTime}s`
  );

  console.log(
    `Speed           : ${finalSpeed} URLs/sec`
  );

  console.log(
    `Rate            : ${Math.round(
      finalSpeed * 60
    )} URLs/min`
  );

  console.log(
    "\n📄 broken-urls-report.csv\n"
  );

})();