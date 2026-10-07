# Background Page Collector

Chrome Manifest V3 extension that processes HTTPS URLs sequentially in inactive tabs, scrolls each rendered page, captures `document.body.innerText` and `document.documentElement.outerHTML`, saves results locally, and closes the tab.

## Backend configuration

In `background.js`, set `NEXT_JOB_URL` and `RESULT_URL` to the backend's `/api/v4/scraping/next` and `/api/v4/scraping/result` endpoints. Set `CRAWLER_API_KEY` to exactly the same long random value configured as `CRAWLER_API_KEY` in the backend environment. The extension will not be able to lease or submit jobs until this is configured.

## Install
1. Unzip the package.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `page-collector-extension` folder.
6. Pin **Background Page Collector** if desired.

## Use
1. Sign in to LinkedIn normally in the same Chrome profile if the pages require authentication.
2. Open the extension popup.
3. Paste one URL per line.
4. Click **Start**.
5. Keep Chrome running while the queue processes.
6. Click **Download JSON** after completion.

## Output
Each successful result contains the requested URL, final URL after redirects, page title, visible rendered text, full rendered DOM HTML, page language, and collection timestamp.

## Permissions
The included manifest permits page access only to `https://www.linkedin.com/*`. To support other sites, add their origins under `host_permissions` (or deliberately use a broader pattern if appropriate).

## Notes
- `active: false` creates a real inactive/background tab; it is not a headless or invisible browser.
- Chrome may throttle background pages, so dynamic sites can require larger wait/scroll values.
- Some content may require interaction or may not be present in the DOM until explicitly expanded.
- Use the extension in accordance with website terms, account rules, and applicable privacy/data-use requirements.
