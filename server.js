#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as B from './browser.js';

const num = (d, desc) => ({ type: 'number', description: desc, ...(d !== undefined ? { default: d } : {}) });
const str = (desc, extra = {}) => ({ type: 'string', description: desc, ...extra });
const bool = (d, desc) => ({ type: 'boolean', description: desc, default: d });

const TOOLS = [
  {
    name: 'open_page',
    description: 'Open a URL in the browser and start capturing console + network errors. Call this first. Returns page title, HTTP status, and which browser mode is active.',
    inputSchema: {
      type: 'object',
      properties: {
        url: str('URL to open. Supports http(s):// and file:// and localhost.'),
        width: num(1280, 'Viewport width in px.'),
        height: num(900, 'Viewport height in px.'),
        wait_until: str('When to consider navigation done.', { enum: ['load', 'domcontentloaded', 'networkidle'], default: 'networkidle' }),
      },
      required: ['url'],
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the current page as an image so you can visually judge layout, spacing, and alignment. Also saves a full-resolution PNG to disk and returns its path.',
    inputSchema: {
      type: 'object',
      properties: {
        width: num(undefined, 'Resize viewport to this width first. Omit to keep current.'),
        full_page: bool(false, 'Capture the entire scrollable page instead of just the viewport.'),
        selector: str('CSS selector to capture just one element. Omit for the whole page.'),
        format: str('png is sharper, jpeg is much cheaper in tokens.', { enum: ['jpeg', 'png'], default: 'jpeg' }),
      },
    },
  },
  {
    name: 'check_responsive',
    description: 'THE core design check. Screenshots the page at several widths and runs a layout audit at each one, so you can see exactly which breakpoint breaks. Reports horizontal overflow, which is the most common responsive bug.',
    inputSchema: {
      type: 'object',
      properties: {
        widths: { type: 'array', items: { type: 'number' }, description: 'Viewport widths to test.', default: [390, 768, 1280] },
        full_page: bool(false, 'Capture full scrollable page at each width.'),
        include_images: bool(true, 'Return screenshots inline. Set false to get findings only (much cheaper).'),
      },
    },
  },
  {
    name: 'audit_design',
    description: 'Run automated design and accessibility checks on the current page: horizontal overflow, tap targets under 44x44, WCAG AA text contrast, images missing alt, text under 12px, and content clipped by overflow:hidden.',
    inputSchema: { type: 'object', properties: { width: num(undefined, 'Audit at this viewport width. Omit to use current.') } },
  },
  {
    name: 'read_console',
    description: 'Read console messages and uncaught page errors captured since the last open_page. JS errors are the usual cause of a page that renders wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: str('Case-insensitive regex to filter message text.'),
        level: str('Only this level.', { enum: ['log', 'info', 'warning', 'error', 'debug', 'pageerror'] }),
        limit: num(50, 'Max messages to return.'),
      },
    },
  },
  {
    name: 'read_network_errors',
    description: 'List failed requests and HTTP 4xx/5xx responses. Catches missing fonts, images, and stylesheets that silently degrade a design.',
    inputSchema: { type: 'object', properties: { limit: num(50, 'Max entries.') } },
  },
  {
    name: 'get_page_text',
    description: 'Read the rendered text of the page, to check copy, hierarchy, and that content actually loaded.',
    inputSchema: {
      type: 'object',
      properties: { selector: str('CSS selector to scope to.'), max_chars: num(4000, 'Truncate at this many characters.') },
    },
  },
  {
    name: 'interact',
    description: 'Drive the page to reach a state worth inspecting: open a menu, submit a form, scroll to a section. Returns any new console errors the action triggered. Avoid elements that open native alert/confirm dialogs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: str('What to do.', { enum: ['click', 'fill', 'hover', 'press', 'scroll', 'wait'] }),
        selector: str('CSS selector. Required for click, fill, hover.'),
        value: str('Text for fill, key name for press, pixels for scroll, ms for wait.'),
      },
      required: ['action'],
    },
  },
  {
    name: 'close_browser',
    description: 'Close the browser and free resources. Call when the inspection is finished.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new Server({ name: 'bob-in-browser', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const text = (o) => ({ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) });
const image = (s) => ({ type: 'image', data: s.base64, mimeType: s.mime });

function summarize(a) {
  const f = a.findings, lines = [];
  const push = (arr, label, fmt) => { if (arr.length) lines.push(`${label} (${arr.length}): ` + arr.map(fmt).join('; ')); };
  push(f.overflow, 'OVERFLOW', (x) => `${x.el} runs ${x.overhang_px}px past the ${x.viewport}px viewport`);
  push(f.tapTargets, 'SMALL TAP TARGET', (x) => `${x.el} "${x.text}" is ${x.size}`);
  push(f.contrast, 'LOW CONTRAST', (x) => `${x.el} "${x.text}" ${x.ratio}:1 (needs ${x.required}:1)`);
  push(f.missingAlt, 'MISSING ALT', (x) => `${x.el} ${x.src}`);
  push(f.tinyText, 'TINY TEXT', (x) => `${x.el} "${x.text}" at ${x.font_px}px`);
  push(f.clipped, 'CLIPPED', (x) => `${x.el} content ${x.content} in box ${x.box}`);
  return lines.length ? lines.join('\n') : 'No issues found by the automated checks.';
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const a = req.params.arguments || {};
  try {
    switch (name) {
      case 'open_page': {
        const r = await B.openPage(a.url, { width: a.width, height: a.height, waitUntil: a.wait_until || 'networkidle' });
        return { content: [text(r)] };
      }
      case 'screenshot': {
        const s = await B.shoot({ width: a.width, fullPage: !!a.full_page, selector: a.selector || null, type: a.format || 'jpeg' });
        return { content: [text({ saved_png: s.file, viewport: s.viewport }), image(s)] };
      }
      case 'check_responsive': {
        const widths = Array.isArray(a.widths) && a.widths.length ? a.widths : [390, 768, 1280];
        const content = [];
        const roll = [];
        for (const w of widths) {
          const au = await B.audit({ width: w });
          roll.push(`--- ${w}px: ${au.total_issues} issue(s) ---\n${summarize(au)}`);
          if (a.include_images !== false) {
            const s = await B.shoot({ width: w, fullPage: !!a.full_page, label: 'bp' });
            content.push(text(`[${w}px] saved: ${s.file}`));
            content.push(image(s));
          }
        }
        content.unshift(text(roll.join('\n\n')));
        return { content };
      }
      case 'audit_design': {
        const au = await B.audit({ width: a.width });
        return { content: [text(`Viewport ${au.viewport}px — ${au.total_issues} issue(s)\n\n${summarize(au)}`), text(au)] };
      }
      case 'read_console':
        return { content: [text(B.readConsole({ pattern: a.pattern, level: a.level, limit: a.limit || 50 }))] };
      case 'read_network_errors':
        return { content: [text(B.readNetwork({ limit: a.limit || 50 }))] };
      case 'get_page_text':
        return { content: [text(await B.pageText({ selector: a.selector, maxChars: a.max_chars || 4000 }))] };
      case 'interact':
        return { content: [text(await B.interact({ action: a.action, selector: a.selector, value: a.value }))] };
      case 'close_browser':
        return { content: [text(await B.closeBrowser())] };
      default:
        return { content: [text(`Unknown tool: ${name}`)], isError: true };
    }
  } catch (e) {
    return { content: [text(`${name} failed: ${e && e.message ? e.message : String(e)}`)], isError: true };
  }
});

const shutdown = async () => { try { await B.closeBrowser(); } catch {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
console.error('bob-in-browser ready on stdio');
