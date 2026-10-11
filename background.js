const CONFIG = {
  // Backend endpoint that returns the next job.
  NEXT_JOB_URL: "http://localhost:9000/api/v4/scraping/next",

  // Backend endpoint where collected page data is sent.
  RESULT_URL: "http://localhost:9000/api/v4/scraping/result",

  // Set this to the same long random value as backend CRAWLER_API_KEY.
  CRAWLER_API_KEY: "WKvQfWGdyb3FYFpwTIs0toqbrSi5EwgDHIMuh",

  // Chrome allows repeating alarms down to 0.5 minutes.
  POLL_INTERVAL_MINUTES: 0.5,

  // Maximum time to wait for normal page loading.
  PAGE_LOAD_TIMEOUT_MS: 45000,

  // Extra time after "complete" for React / JS rendered pages.
  RENDER_WAIT_MS: 3000,

  // Scrolling behavior.
  SCROLL_DELAY_MS: 700,
  MAX_SCROLLS: 30,
};

const ALARM_NAME = "page-collector-check-jobs";

let isProcessing = false;

/**
 * -----------------------------------
 * Startup
 * -----------------------------------
 */

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Page Collector] Installed");

  await ensureAlarm();

  // Optional immediate check.
  checkForJob();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[Page Collector] Chrome started");

  await ensureAlarm();

  checkForJob();
});

/**
 * Recreate alarm if needed.
 * MV3 service workers are not persistent.
 */
async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);

  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 0.1,
      periodInMinutes: CONFIG.POLL_INTERVAL_MINUTES,
    });

    console.log("[Page Collector] Alarm created");
  }
}

/**
 * -----------------------------------
 * Alarm
 * -----------------------------------
 */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  checkForJob();
});

/**
 * -----------------------------------
 * Backend queue
 * -----------------------------------
 */

async function checkForJob() {
  if (isProcessing) {
    console.log("[Page Collector] Already processing");
    return;
  }

  isProcessing = true;

  try {
    console.log("[Page Collector] Checking for job...");

    const response = await fetch(CONFIG.NEXT_JOB_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Crawler-Key": CONFIG.CRAWLER_API_KEY,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Job API returned HTTP ${response.status}`);
    }

    const job = await response.json();

    /*
      Expected response when job exists:

      {
        "id": 123,
        "url": "https://www.sainsburys.co.uk/groceries/product/..."
      }

      Expected response when no work exists:

      {
        "job": null
      }

      or:

      {}
    */

    if (!job?.url) {
      console.log("[Page Collector] No jobs available");
      return;
    }

    console.log("[Page Collector] Processing:", job.id, job.url);

    const result = await collectPage(job.url);

    await sendResult({
      jobId: job.id ?? null,
      ...result,
    });
  } catch (error) {
    console.error("[Page Collector] Queue error:", error);
  } finally {
    isProcessing = false;
  }
}

/**
 * -----------------------------------
 * Page collection
 * -----------------------------------
 */

async function collectPage(url) {
  let tabId = null;

  const startedAt = new Date().toISOString();

  try {
    validateUrl(url);

    /*
      Create a real Chrome tab, but do not focus it.
    */
    const tab = await chrome.tabs.create({
      url: url,
      active: false,
    });

    tabId = tab.id;

    if (!tabId) {
      throw new Error("Chrome did not return a tab ID");
    }

    console.log(`[Page Collector] Opened tab ${tabId}`);

    /*
      Wait until Chrome reports the normal document
      loading process as complete.
    */
    await waitForTabComplete(tabId, CONFIG.PAGE_LOAD_TIMEOUT_MS);

    /*
      Dynamic sites may continue rendering after
      status === "complete".
    */
    await sleep(CONFIG.RENDER_WAIT_MS);

    /*
      Run extraction inside the website itself.
    */
    const executionResults = await chrome.scripting.executeScript({
      target: {
        tabId: tabId,
      },

      func: async (scrollDelay, maxScrolls) => {
        /*
         * Wait until body exists.
         */
        const waitForBody = async () => {
          const started = Date.now();

          while (!document.body) {
            if (Date.now() - started > 15000) {
              throw new Error("document.body did not appear");
            }

            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        };

        await waitForBody();

        /*
         * Scroll through page.
         *
         * Useful for:
         * - lazy loaded images
         * - product sections
         * - React components
         * - infinite-ish content
         */
        let previousHeight = 0;
        let unchangedCount = 0;

        for (let i = 0; i < maxScrolls; i++) {
          const currentHeight = Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
          );

          window.scrollTo({
            top: currentHeight,
            behavior: "instant",
          });

          await new Promise((resolve) => setTimeout(resolve, scrollDelay));

          const newHeight = Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
          );

          if (newHeight === previousHeight) {
            unchangedCount++;
          } else {
            unchangedCount = 0;
          }

          previousHeight = newHeight;

          /*
           * Stop when scrolling no longer
           * causes page growth.
           */
          if (unchangedCount >= 3) {
            break;
          }
        }

        /*
         * Return to top.
         */
        window.scrollTo({
          top: 0,
          behavior: "instant",
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        /*
         * Capture useful metadata.
         */
        const canonical =
          document.querySelector('link[rel="canonical"]')?.href ?? null;

        const description =
          document.querySelector('meta[name="description"]')?.content ?? null;

        /*
         * Sainsbury's product pages use <main> as the product-content boundary.
         * Other sites keep the existing full-body capture.
         */
        const isSainsburys = /(^|\.)sainsburys\.co\.uk$/i.test(location.hostname);
        const contentRoot = isSainsburys
          ? document.querySelector("main")
          : document.body;

        if (isSainsburys && !contentRoot) {
          throw new Error("Sainsbury's page did not contain a <main> element");
        }

        return {
          url: location.href,

          requestedUrl: location.href,

          title: document.title || null,

          canonical,

          description,

          // Keep the <main> wrapper for Sainsbury's; use the full body elsewhere.
          html: contentRoot?.outerHTML ?? "",

          pageHeight: Math.max(
            document.body?.scrollHeight || 0,

            document.documentElement?.scrollHeight || 0,
          ),

          collectedAt: new Date().toISOString(),
        };
      },

      args: [CONFIG.SCROLL_DELAY_MS, CONFIG.MAX_SCROLLS],
    });

    if (!executionResults || executionResults.length === 0) {
      throw new Error("No extraction result returned");
    }

    const page = executionResults[0].result;

    if (!page) {
      throw new Error("Injected script returned no page data");
    }

    return {
      success: true,

      requestedUrl: url,

      startedAt,

      completedAt: new Date().toISOString(),

      ...page,
    };
  } catch (error) {
    console.error("[Page Collector] Collection failed:", url, error);

    return {
      success: false,

      requestedUrl: url,

      startedAt,

      completedAt: new Date().toISOString(),

      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    /*
      Always close the temporary tab.
    */
    if (tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);

        console.log(`[Page Collector] Closed tab ${tabId}`);
      } catch (error) {
        console.warn("[Page Collector] Could not close tab:", error);
      }
    }
  }
}

/**
 * -----------------------------------
 * Send result to backend
 * -----------------------------------
 */

async function sendResult(result) {
  console.log("[Page Collector] Sending result:", result.jobId, result.success);

  const response = await fetch(CONFIG.RESULT_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Crawler-Key": CONFIG.CRAWLER_API_KEY,
    },

    body: JSON.stringify(result),
  });

  if (!response.ok) {
    throw new Error(`Result API returned HTTP ${response.status}`);
  }

  console.log("[Page Collector] Result sent");
}

/**
 * -----------------------------------
 * Wait for page
 * -----------------------------------
 */

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);

      clearTimeout(timeout);
    };

    const finish = () => {
      if (finished) return;

      finished = true;

      cleanup();

      resolve();
    };

    const fail = (error) => {
      if (finished) return;

      finished = true;

      cleanup();

      reject(error);
    };

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    /*
     * The tab may already have finished
     * before the listener was attached.
     */
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          finish();
        }
      })
      .catch(fail);

    const timeout = setTimeout(() => {
      fail(new Error(`Page load timeout after ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
  });
}

/**
 * -----------------------------------
 * Helpers
 * -----------------------------------
 */

function validateUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
