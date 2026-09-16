# bob-in-browser

**A browser-inspection MCP server.** It gives any MCP client the ability to open a website,
*look* at it, and judge whether it actually renders correctly — not just whether it returns 200.

Most browser automation tools are built for end-to-end testing: assert that a button exists, that
a form submits. This one is built for **visual and design review**. It answers the question *"does
this page look right?"* with screenshots at real breakpoints plus a deterministic audit of the
things that most often look wrong.

```
Viewport 390px — 7 issue(s)

OVERFLOW (1): div.wide runs 1050px past the 390px viewport
SMALL TAP TARGET (2): button.smallbtn "x" is 24x24; a.smallbtn "y" is 6x12
LOW CONTRAST (1): p.faint "This grey text fails WCAG AA contrast" 1.92:1 (needs 4.5:1)
MISSING ALT (1): img logo.png
TINY TEXT (1): p.tiny "This text is only 9 pixels tall" at 9px
CLIPPED (1): div.clip content 410x20 in box 120x20
```

Every finding names the element and its text, so it is actionable — not a score, not a count.

---

## Contents

- [Why this exists](#why-this-exists)
- [Requirements](#requirements)
- [Install](#install)
- [Connect it to your MCP client](#connect-it-to-your-mcp-client)
- [Two browser modes](#two-browser-modes)
- [Configuration](#configuration)
- [Tool reference](#tool-reference)
- [What the audit catches](#what-the-audit-catches)
- [Use cases](#use-cases)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Why this exists

Anthropic's Claude Code ships a "Claude in Chrome" extension that lets the model drive your real
browser. It is genuinely useful for design work, but it cannot be reused by other clients: it is
bound by Chrome Native Messaging to a single whitelisted extension ID, talking over stdio to the
`claude` binary specifically. There is no open port and no documented protocol for anything else
to connect to.

`bob-in-browser` is a clean-room equivalent built on [Playwright](https://playwright.dev) that
speaks **standard MCP over stdio**, so any MCP-capable client can use it. It also keeps the one
genuinely distinctive capability of the extension — inspecting pages using your *already
logged-in* browser session — via Chrome DevTools Protocol attach.

---

## Requirements

| | |
|---|---|
| **Node.js** | 18 or newer (developed and tested on Node 26) |
| **Browser** | Google Chrome, or let Playwright install its own Chromium |
| **OS** | macOS, Linux, or Windows |

---

## Install

Clone or unzip, then from inside the folder:

```sh
npm install
npx playwright install chromium   # only if Chrome/Chromium is missing
```

### Verify before wiring anything up

Two self-contained checks, neither of which needs an MCP client:

```sh
npm run smoke          # audits a deliberately broken page; expects 7 findings
./test/mcp-probe.sh    # full JSON-RPC handshake over stdio; exits 0
```

`npm run smoke` loads `test/broken.html`, a fixture with one instance of every defect the audit
detects, and prints what it found. If you see 7 issues across 6 categories, the audit engine works.

`./test/mcp-probe.sh` speaks raw MCP at the server exactly as a client would — `initialize`,
`tools/list`, `tools/call`, `close_browser` — and exits cleanly. If that passes, any MCP client
can talk to it.

---

## Connect it to your MCP client

This is a standard stdio MCP server. Add it to your client's MCP configuration:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/bob-in-browser/server.js"],
      "env": {
        "BOB_BROWSER_HEADLESS": "true"
      }
    }
  }
}
```

**Use an absolute path.** MCP clients do not expand `~` and do not resolve paths relative to your
shell's working directory. This is the single most common setup failure.

If your client uses a different top-level key — some use `servers`, some use a TOML block — keep
the `command` / `args` / `env` triple intact. That part is universal across MCP implementations.

---

## Two browser modes

### 1. Launch (default)

The server starts its own browser instance. Clean state every run, no interference with your
daily browsing. This is what you want for local development and public URLs.

Uses your installed Google Chrome when available for the most accurate rendering, and falls back
to Playwright's bundled Chromium otherwise. The mode in use is reported by `open_page` so you
always know what rendered your screenshot.

### 2. Attach to a running Chrome

Inspect pages **behind a login** without re-authenticating, by attaching to a Chrome you have
already signed into. This is the capability a plain headless browser cannot give you.

```sh
# 1. Quit Chrome completely, then start it with the DevTools port open.
#    The separate --user-data-dir keeps this isolated from your main profile.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-inspect-profile"

# 2. Point the server at it.
export BOB_BROWSER_CDP_URL=http://localhost:9222
```

Sign in to the target app once in that window. Every subsequent inspection reuses the session.

> **Security note:** `--remote-debugging-port` lets any local process drive that browser. Use a
> dedicated `--user-data-dir` as shown, close the window when finished, and do not enable it on a
> shared or untrusted machine.

---

## Configuration

All configuration is environment variables — no config file.

| Variable | Default | Purpose |
|---|---|---|
| `BOB_BROWSER_CDP_URL` | *(unset)* | Attach to a running Chrome at this CDP URL instead of launching one. E.g. `http://localhost:9222`. |
| `BOB_BROWSER_HEADLESS` | `true` | Set to `false` to watch the browser work in a visible window. Useful when debugging a selector. |
| `BOB_BROWSER_OUT` | `$TMPDIR/bob-in-browser-shots` | Directory for full-resolution PNG screenshots. |

---

## Tool reference

Nine tools. `open_page` first, `close_browser` last, anything in between.

### `open_page`

Navigate to a URL and begin capturing console output and network failures. **Call this first** —
the capture buffers reset on every call, so each page gets a clean log.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `url` | string | *required* | `http(s)://`, `file://`, and `localhost` all work |
| `width` | number | `1280` | Viewport width in px |
| `height` | number | `900` | Viewport height in px |
| `wait_until` | enum | `networkidle` | `load`, `domcontentloaded`, or `networkidle` |

Returns the final URL, page title, HTTP status, and active browser mode.

### `screenshot`

Capture the page as an image. Returns it **inline as JPEG** (cheap in context) and simultaneously
saves a **full-resolution PNG to disk**, returning the path.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `width` | number | *current* | Resize viewport before capturing |
| `full_page` | boolean | `false` | Capture the whole scrollable page |
| `selector` | string | — | Capture just one element |
| `format` | enum | `jpeg` | `png` is sharper; `jpeg` is far cheaper in tokens |

### `check_responsive`

**The core tool.** Screenshots *and* audits the page at several widths in one call, so you can see
precisely which breakpoint breaks rather than guessing.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `widths` | number[] | `[390, 768, 1280]` | Phone, tablet, desktop |
| `full_page` | boolean | `false` | Full scrollable capture at each width |
| `include_images` | boolean | `true` | Set `false` for findings only — much cheaper |

### `audit_design`

Run the automated design and accessibility checks at a single width. See
[What the audit catches](#what-the-audit-catches).

| Parameter | Type | Default |
|---|---|---|
| `width` | number | *current viewport* |

### `read_console`

Console messages and uncaught page errors captured since `open_page`. A JS error is the most
common reason a page renders wrong.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `pattern` | string | — | Case-insensitive regex filter on message text |
| `level` | enum | — | `log`, `info`, `warning`, `error`, `debug`, `pageerror` |
| `limit` | number | `50` | Most recent N |

### `read_network_errors`

Failed requests and HTTP 4xx/5xx responses — catches missing fonts, images, and stylesheets that
silently degrade a design without throwing any error.

| Parameter | Type | Default |
|---|---|---|
| `limit` | number | `50` |

### `get_page_text`

The rendered text of the page. Use it to check copy, heading hierarchy, and that content actually
loaded rather than silently failing.

| Parameter | Type | Default |
|---|---|---|
| `selector` | string | *whole body* |
| `max_chars` | number | `4000` |

### `interact`

Drive the page to a state worth inspecting — open a menu, submit a form, scroll to a section.
Returns any new console errors the action triggered.

| Parameter | Type | Notes |
|---|---|---|
| `action` | enum | `click`, `fill`, `hover`, `press`, `scroll`, `wait` |
| `selector` | string | Required for `click`, `fill`, `hover` |
| `value` | string | Text for `fill`, key for `press`, px for `scroll`, ms for `wait` |

> Avoid clicking controls that open native `alert` / `confirm` / `prompt` dialogs. They block the
> page and stall further commands.

### `close_browser`

Close the browser and release resources. Takes no parameters.

---

## What the audit catches

Six deterministic checks, each capped at 8 findings per run so output stays readable. All
thresholds come from published standards rather than taste.

| Check | Rule | Why it matters |
|---|---|---|
| **Horizontal overflow** | Element extends past the viewport edge, excluding `position: fixed` | The single most common responsive bug. Causes the whole page to scroll sideways on phones. |
| **Small tap targets** | Interactive element under 44×44 px | WCAG 2.5.5 and the Apple HIG minimum. Below this, people miss the target. |
| **Low contrast** | Below WCAG AA — 4.5:1 body, 3:1 large text | Large text is ≥24px, or ≥18.66px bold. Unreadable for low-vision users and in sunlight. |
| **Missing alt** | `<img>` with no `alt` attribute at all | `alt=""` is correctly treated as a valid decorative marker and is **not** flagged. |
| **Tiny text** | Rendered font size under 12px | Below comfortable reading size on any device. |
| **Clipped content** | `overflow: hidden` with content larger than its box | Text silently cut off — often only at certain widths or in certain languages. |

**On contrast specifically:** the check resolves the *actual* background by walking up the
ancestor chain until it finds a colour with alpha > 0.5, so inherited and transparent backgrounds
are handled correctly rather than assumed to be white. Interactive elements are matched by role as
well as tag (`[role="button"]`, `[role="link"]`, `[onclick]`), so custom components are covered.

Elements that are `display:none`, `visibility:hidden`, `opacity:0`, or zero-sized are skipped
throughout — hidden content is not judged.

---

## Use cases

### Catch a responsive break before it ships

```
open_page        { url: "http://localhost:3000/pricing" }
check_responsive { widths: [360, 390, 768, 1024, 1440] }
```

One call, five viewports, screenshots plus findings for each. When the pricing table overflows at
768px but not 1024px, you see exactly that — with the offending selector named.

### Debug a page that renders wrong

```
open_page           { url: "https://staging.example.com" }
read_console        { level: "error" }
read_network_errors {}
screenshot          { full_page: true }
```

Covers the three usual culprits in order: a JS exception that halted rendering, an asset that
failed to load, and finally what the page actually looks like.

### Accessibility pass before a release

```
open_page    { url: "https://example.com/checkout", width: 390 }
audit_design {}
```

Contrast, tap targets, alt text, and text size in one pass, at the viewport where these problems
are worst.

### Inspect a page behind a login

Start Chrome with `--remote-debugging-port=9222`, sign in once, set `BOB_BROWSER_CDP_URL`, then
inspect authenticated pages normally. Dashboards, admin panels, and internal tools become
reviewable without scripting a login flow or storing credentials.

### Review a state that only exists after interaction

```
open_page  { url: "https://example.com" }
interact   { action: "click", selector: "nav .menu-toggle" }
screenshot { }
audit_design {}
```

Mobile menus, modals, and expanded accordions are frequently where layout breaks, precisely
because they are not visible in a static screenshot.

### Compare a build against a reference

Point it at a production URL and a local build at the same widths, and compare the saved PNGs.
Every capture returns its path, so the files are there to diff by eye or by tool.

---

## How it works

```
MCP client  ──stdio JSON-RPC──▶  server.js      tool schemas, dispatch, result shaping
                                     │
                                     ▼
                                 browser.js     Playwright lifecycle, console/network capture
                                     │
                                     ▼
                                 checks.js      audit function, executed inside the page
```

- **`server.js`** declares the nine tools as raw JSON Schema — deliberately not zod — so the
  server does not impose a validation-library version on the client. Results are shaped into MCP
  `text` and `image` content blocks.
- **`browser.js`** owns the single browser/page instance, decides between launch and CDP attach,
  and wires the `console`, `pageerror`, `requestfailed`, and `response` listeners whose buffers
  back `read_console` and `read_network_errors`.
- **`checks.js`** exports one self-contained function serialized into the page by
  `page.evaluate()`. It closes over nothing, so it runs correctly in the browser context.

`open_page` falls back from `networkidle` to `domcontentloaded` automatically, so pages that poll
continuously do not hang the call — a common failure with naive Playwright wrappers.

---

## Troubleshooting

**The client shows no tools.** Almost always a path problem. Confirm the server runs standalone
with `./test/mcp-probe.sh`, then check that `args` uses an absolute path with no `~`.

**`browserType.launch: Executable doesn't exist`.** Playwright has no browser installed. Run
`npx playwright install chromium`.

**CDP attach fails with `ECONNREFUSED`.** Chrome is not running with the debugging port, or was
already running when you launched it with the flag. Quit Chrome **completely** first — the flag is
ignored if an instance is already up.

**Screenshots are blank or half-rendered.** The page is still loading. Use
`wait_until: "networkidle"`, or add `interact { action: "wait", value: "1500" }` before capturing.

**The server seems to hang.** It is a long-lived stdio server; staying alive is correct. It exits
when stdin closes, provided the browser has been released — call `close_browser` when done.

**Everything is flagged as low contrast.** Usually a page that sets colours via a framework
stylesheet that failed to load. Check `read_network_errors` first.

---

## Limitations

- **One page at a time.** A single browser and page instance; no parallel tabs or sessions.
- **The audit is deterministic, not aesthetic.** It finds measurable defects — overflow, contrast,
  size. It does not judge whether a design is *good*. Pair the screenshots with a model's visual
  judgment for that.
- **No visual regression diffing.** Screenshots are saved with paths returned, but comparing them
  across runs is left to you.
- **No native dialog handling.** `alert` / `confirm` / `prompt` will block the page.
- **Contrast checking assumes solid backgrounds.** Text over an image or gradient is resolved to
  the nearest solid ancestor colour, which may not reflect what a reader actually sees.

---

## License

MIT
