import { chromium, firefox, webkit } from 'playwright';
import { auditFn } from './checks.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ENGINES = { chromium, firefox, webkit };
const DEFAULT_ENGINE = (process.env.BOB_BROWSER_ENGINE || 'chromium').toLowerCase();
const CDP_URL = process.env.BOB_BROWSER_CDP_URL || '';
const HEADLESS = process.env.BOB_BROWSER_HEADLESS !== 'false';
const OUT_DIR = process.env.BOB_BROWSER_OUT || path.join(os.tmpdir(), 'bob-in-browser-shots');

let browser = null, context = null, page = null, mode = 'none';
let engine = DEFAULT_ENGINE;
let consoleLog = [], networkLog = [], pageErrors = [];

export function resetLogs() { consoleLog = []; networkLog = []; pageErrors = []; }

function wire(p) {
  p.on('console', (m) => {
    consoleLog.push({ level: m.type(), text: m.text().slice(0, 500), at: new Date().toISOString() });
    if (consoleLog.length > 500) consoleLog.shift();
  });
  p.on('pageerror', (e) => {
    pageErrors.push({ text: String(e && e.message || e).slice(0, 500), at: new Date().toISOString() });
    if (pageErrors.length > 200) pageErrors.shift();
  });
  p.on('requestfailed', (r) => {
    networkLog.push({ kind: 'failed', method: r.method(), url: r.url().slice(0, 300), type: r.resourceType(), error: (r.failure() && r.failure().errorText) || 'unknown' });
    if (networkLog.length > 300) networkLog.shift();
  });
  p.on('response', (r) => {
    if (r.status() >= 400) {
      networkLog.push({ kind: 'http_error', status: r.status(), url: r.url().slice(0, 300), type: r.request().resourceType() });
      if (networkLog.length > 300) networkLog.shift();
    }
  });
}

export async function ensurePage(want) {
  const target = (want || engine).toLowerCase();
  if (!ENGINES[target]) throw new Error(`unknown engine "${target}" — use chromium, firefox, or webkit`);
  // Switching engines requires a fresh browser.
  if (page && !page.isClosed() && target === engine) return page;
  if (page && target !== engine) await closeBrowser();
  engine = target;

  if (CDP_URL) {
    if (engine !== 'chromium') {
      throw new Error(`BOB_BROWSER_CDP_URL is set, but CDP attach only works with chromium (engine is "${engine}"). Unset it to launch ${engine}.`);
    }
    // Attach to an already-running Chrome — keeps the existing login session.
    browser = await chromium.connectOverCDP(CDP_URL);
    mode = 'attached:chromium:' + CDP_URL;
    context = browser.contexts()[0] || (await browser.newContext());
    page = context.pages().find((p) => !p.isClosed()) || (await context.newPage());
  } else {
    const tag = (HEADLESS ? ':headless' : ':headed');
    if (engine === 'chromium') {
      try {
        browser = await chromium.launch({ headless: HEADLESS, channel: 'chrome' });
        mode = 'launched:chrome' + tag;
      } catch {
        browser = await chromium.launch({ headless: HEADLESS });
        mode = 'launched:chromium' + tag;
      }
    } else {
      try {
        browser = await ENGINES[engine].launch({ headless: HEADLESS });
      } catch (e) {
        throw new Error(`could not launch ${engine}: ${e.message}. Run: npx playwright install ${engine}`);
      }
      mode = 'launched:' + engine + tag;
    }
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    page = await context.newPage();
  }
  wire(page);
  return page;
}

export function getEngine() { return engine; }

export function getMode() { return mode; }

export async function openPage(url, { width, height, waitUntil = 'networkidle', timeout = 30000, engine: want } = {}) {
  const p = await ensurePage(want);
  resetLogs();
  if (width) await p.setViewportSize({ width, height: height || 900 });
  let status = null;
  try {
    const resp = await p.goto(url, { waitUntil, timeout });
    status = resp ? resp.status() : null;
  } catch (e) {
    // networkidle often never settles on polling apps — fall back to DOM ready.
    const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout });
    status = resp ? resp.status() : null;
  }
  await p.waitForTimeout(300);
  return { url: p.url(), title: await p.title(), status, engine, mode, viewport: p.viewportSize() };
}

export async function shoot({ width, height, fullPage = false, selector = null, type = 'jpeg', quality = 80, label = 'shot' } = {}) {
  const p = await ensurePage();
  if (width) await p.setViewportSize({ width, height: height || 900 });
  await p.waitForTimeout(250);
  const optsPng = { fullPage, type: 'png' };
  const optsInline = type === 'png' ? { fullPage, type: 'png' } : { fullPage, type: 'jpeg', quality };

  await fs.mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, `${label}-${width || 'cur'}w-${stamp}.png`);

  const target = selector ? p.locator(selector).first() : p;
  const pngBuf = await target.screenshot(selector ? { type: 'png' } : optsPng);
  await fs.writeFile(file, pngBuf);
  const inlineBuf = await target.screenshot(selector ? { type: 'png' } : optsInline);

  return {
    file,
    base64: inlineBuf.toString('base64'),
    mime: type === 'png' || selector ? 'image/png' : 'image/jpeg',
    viewport: p.viewportSize(),
  };
}

export async function audit({ width } = {}) {
  const p = await ensurePage();
  if (width) { await p.setViewportSize({ width, height: 900 }); await p.waitForTimeout(300); }
  return await p.evaluate(auditFn, { limit: 8 });
}

export function readConsole({ pattern = null, level = null, limit = 50 } = {}) {
  let rows = consoleLog.concat(pageErrors.map((e) => ({ level: 'pageerror', text: e.text, at: e.at })));
  if (level) rows = rows.filter((r) => r.level === level);
  if (pattern) { const re = new RegExp(pattern, 'i'); rows = rows.filter((r) => re.test(r.text)); }
  return rows.slice(-limit);
}

export function readNetwork({ limit = 50 } = {}) { return networkLog.slice(-limit); }

export async function pageText({ selector = null, maxChars = 4000 } = {}) {
  const p = await ensurePage();
  const t = selector ? await p.locator(selector).first().innerText() : await p.evaluate(() => document.body.innerText);
  return t.replace(/\n{3,}/g, '\n\n').slice(0, maxChars);
}

export async function interact({ action, selector, value, timeout = 10000 }) {
  const p = await ensurePage();
  const before = consoleLog.length + pageErrors.length;
  switch (action) {
    case 'click': await p.locator(selector).first().click({ timeout }); break;
    case 'fill': await p.locator(selector).first().fill(value ?? '', { timeout }); break;
    case 'hover': await p.locator(selector).first().hover({ timeout }); break;
    case 'press': await p.keyboard.press(value || 'Enter'); break;
    case 'scroll': await p.evaluate((y) => window.scrollBy(0, y), Number(value) || 600); break;
    case 'wait': await p.waitForTimeout(Math.min(Number(value) || 1000, 10000)); break;
    default: throw new Error(`unknown action: ${action}`);
  }
  await p.waitForTimeout(400);
  const newMsgs = consoleLog.concat(pageErrors).slice(before);
  return { ok: true, action, selector: selector || null, url: p.url(), new_console: newMsgs.slice(-10) };
}

export async function closeBrowser() {
  try {
    if (browser) { if (CDP_URL) await browser.close(); else await browser.close(); }
  } catch {}
  browser = context = page = null; mode = 'none'; resetLogs();
  return { closed: true };
}

export { OUT_DIR };
