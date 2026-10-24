# RULES — read before you touch anything

## 1. Never disturb the user's machine
The user works on this Mac while we run. Our work must be **invisible**.

- **NEVER** run `pkill`/`killall` with a name pattern like "Chrome", "Chromium", "node".
  We already broke the user's browser once this way. Kill only PIDs matched **strictly**
  on our own `--user-data-dir=/tmp/gauntlet-browsers/<name>/profile`.
- **NEVER** launch `/Applications/Google Chrome.app` (the user's browser).
  Use only Playwright's bundled binary, via `gauntlet/browser.mjs`.
- **ALWAYS headless.** No visible windows, ever. `browser.mjs` enforces
  `--headless=new` and rejects `--headed`; there is no headed mode.
- Never reuse a listening port unless its owner is verified as this tool's bundled
  browser with the exact isolated profile and `--headless=new`.
- Do not use `open`, `osascript`, or anything that steals focus.
- Clean up: `node gauntlet/browser.mjs down <name>` when you are done.

## 2. Browser usage
All capture/performance work is owned by the root agent and run serially through
`run-round.mjs`. Use one unique temporary profile per run; its `finally` block
must report `remaining: 0` before review begins. Reviewers read existing images,
never open browsers. Do not reuse the historical long-lived `ours` profile.

```bash
node gauntlet/run-round.mjs --out gauntlet/rounds/<round> --perf-ms 6000
node gauntlet/browser.mjs list
node gauntlet/browser.mjs down <exact-owned-profile>
```
Connect with `chromium.connectOverCDP('http://127.0.0.1:<port>')`.
Headless here is real GPU: `ANGLE Metal Renderer: Apple M4 Pro`. WebGL2 works.

## 3. Playwright discipline (learned the hard way)
- Await browser cleanup in `finally` before exit; use a timeout and signal handler
  to clean up the exact owned profile on failure or interruption too.
- Never use auto-waiting locators (`getByText().click()`); use
  `page.evaluate(() => el.click())` or `page.mouse.click(x, y)` on measured coords.
- Pass explicit timeouts (<= 20000) to every playwright call.
- Write screenshots to disk immediately; never batch 20 captures into one long script.

## 4. Ports
| port | owner |
|------|-------|
| 5188 | our game dev server |
| 5199 | live progress page |
| 9223 | headless browser "ours" (shooting our game) |
| 9231+ | per-critic headless browsers |

## 5. Verify with your own eyes
Any claim about how something looks must be backed by a screenshot you opened with the
Read tool. No "it should look like X".
