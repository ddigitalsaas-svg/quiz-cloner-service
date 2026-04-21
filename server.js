const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json({ limit: '50mb' }));

const SECRET_TOKEN = process.env.SECRET_TOKEN;

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (SECRET_TOKEN) {
    const token = req.headers['x-token'] || req.body?.token;
    if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Strategy 1: Intercept CryptoJS + fetch before page loads ─────────────────
// Catches Inlead (AES-encrypted __NEXT_DATA__) and REST-API platforms
const INTERCEPT_SCRIPT = `
(function() {
  window.__quizCapture = { data: null, source: null };

  function looksLikeQuiz(obj) {
    if (!obj || typeof obj !== 'object') return false;
    // Direct steps array
    if (Array.isArray(obj.steps) && obj.steps.length > 0) return true;
    // Nested: funnel.steps, quiz.steps, pageProps.funnel.steps, etc.
    for (const key of ['funnel', 'quiz', 'survey', 'form', 'pageProps']) {
      if (obj[key] && Array.isArray(obj[key].steps) && obj[key].steps.length > 0) return true;
    }
    return false;
  }

  function tryCapture(data, source) {
    if (window.__quizCapture.data) return; // already captured
    try {
      const obj = typeof data === 'string' ? JSON.parse(data) : data;
      if (looksLikeQuiz(obj)) {
        window.__quizCapture.data = obj;
        window.__quizCapture.source = source;
      }
    } catch {}
  }

  // ── Intercept CryptoJS AES decrypt (Inlead, Cakto, etc.) ──
  function patchCryptoJS(CJ) {
    if (!CJ || !CJ.AES || CJ.__patched) return;
    CJ.__patched = true;
    const orig = CJ.AES.decrypt.bind(CJ.AES);
    CJ.AES.decrypt = function(ciphertext, key, cfg) {
      const result = orig(ciphertext, key, cfg);
      try {
        const plain = result.toString(CJ.enc.Utf8);
        if (plain.startsWith('{') || plain.startsWith('[')) {
          tryCapture(plain, 'cryptojs');
        }
      } catch {}
      return result;
    };
  }

  // Watch for CryptoJS being set on window
  let _cj;
  Object.defineProperty(window, 'CryptoJS', {
    configurable: true,
    get() { return _cj; },
    set(v) {
      _cj = v;
      setTimeout(() => patchCryptoJS(v), 0);
    },
  });

  // ── Intercept fetch (REST API platforms) ──
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    if (!window.__quizCapture.data) {
      res.clone().json().then(d => tryCapture(d, 'fetch')).catch(() => {});
    }
    return res;
  };

  // ── Intercept XHR ──
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', () => {
      if (!window.__quizCapture.data) {
        tryCapture(this.responseText, 'xhr');
      }
    });
    return origSend.apply(this, args);
  };
})();
`;

// ─── Map captured quiz data to our step format ────────────────────────────────
function mapCapturedSteps(capturedData) {
  // Find the steps array wherever it lives
  let rawSteps =
    capturedData.steps ||
    capturedData.funnel?.steps ||
    capturedData.quiz?.steps ||
    capturedData.survey?.steps ||
    capturedData.pageProps?.funnel?.steps ||
    capturedData.pageProps?.steps ||
    null;

  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;

  return rawSteps.map((s) => {
    // Normalize: different platforms use different field names
    const title =
      s.title || s.question || s.heading || s.name || s.label || '';
    const subtitle =
      s.subtitle || s.description || s.subheading || s.body || '';
    const heroImageUrl =
      s.heroImageUrl || s.imageUrl || s.image?.url || s.background_image || null;

    // Options: could be options[], choices[], answers[], alternatives[]
    const rawOpts =
      s.options || s.choices || s.answers || s.alternatives || s.items || [];
    const options = rawOpts.map((o) => {
      if (typeof o === 'string') return { text: o, emoji: null, imageUrl: null };
      return {
        text: o.text || o.label || o.value || o.title || '',
        emoji: o.emoji || null,
        imageUrl: o.imageUrl || o.image?.url || o.image || null,
      };
    });

    // Detect type
    const hasEmail = !!(s.fields || s.inputs || []).find?.(f =>
      (f.type || '').includes('email') || (f.name || '').includes('email')
    );
    let type = s.type || s.stepType || s.kind || 'single-choice';

    // Normalize type names
    if (/lead|capture|form|email|contato/i.test(type) || hasEmail) type = 'lead-capture';
    else if (/content|info|landing|page|pg|result/i.test(type)) type = 'content';
    else if (/multi/i.test(type)) type = 'multiple-choice';
    else if (options.length >= 2) type = 'single-choice';
    else type = 'content';

    const leadFields = type === 'lead-capture'
      ? (s.fields || s.inputs || s.leadFields || []).map((f) => ({
          label: f.label || f.placeholder || f.name || '',
          fieldType: /email/i.test(f.type || f.name || '') ? 'email'
            : /nome|name/i.test(f.name || f.placeholder || '') ? 'name'
            : /phone|fone|whatsapp|tel/i.test(f.name || f.placeholder || '') ? 'phone'
            : 'custom',
        }))
      : undefined;

    return { type, title, subtitle, heroImageUrl, options, leadFields, screenshot: null };
  });
}

// ─── Strategy 2: Extract from React fiber (fallback for SSR/hydrated apps) ────
async function extractFromReactFiber(page) {
  return page.evaluate(() => {
    function looksLikeQuiz(obj) {
      if (!obj || typeof obj !== 'object') return false;
      for (const key of ['steps', 'funnel', 'quiz', 'survey']) {
        const v = obj[key];
        if (Array.isArray(v) && v.length > 0) return true;
        if (v && Array.isArray(v.steps) && v.steps.length > 0) return true;
      }
      return false;
    }

    function searchObj(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 6) return null;
      if (looksLikeQuiz(obj)) return obj;
      for (const key of Object.keys(obj)) {
        try {
          const found = searchObj(obj[key], depth + 1);
          if (found) return found;
        } catch {}
      }
      return null;
    }

    function traverseFiber(fiber, depth) {
      if (!fiber || depth > 80) return null;
      try {
        if (fiber.memoizedProps) {
          const found = searchObj(fiber.memoizedProps, 0);
          if (found) return found;
        }
      } catch {}
      try {
        let s = fiber.memoizedState;
        while (s) {
          const found = searchObj(s.memoizedState, 0) || searchObj(s.queue?.lastRenderedState, 0);
          if (found) return found;
          s = s.next;
        }
      } catch {}
      return traverseFiber(fiber.child, depth + 1) || traverseFiber(fiber.sibling, depth + 1);
    }

    const root = document.getElementById('__next') || document.getElementById('root') || document.body;
    const fiberKey = Object.keys(root).find(k =>
      k.startsWith('__reactFiber') || k.startsWith('__reactInternals') || k.startsWith('__reactContainer')
    );
    if (!fiberKey) return null;
    return traverseFiber(root[fiberKey], 0);
  });
}

// ─── Strategy 3: Step-by-step Puppeteer navigation (universal fallback) ───────

async function waitForStable(page, timeout = 6000) {
  await Promise.race([
    page.evaluate(() => new Promise((resolve) => {
      let timer;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(resolve, 600);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      setTimeout(resolve, 4000);
    })),
    delay(timeout),
  ]);
}

async function getCurrentStepSignature(page) {
  return page.evaluate(() => {
    const selectors = ['h1', 'h2', '[class*="question"]', '[class*="title"]', '[class*="step-title"]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const text = el?.innerText?.trim();
      if (text && text.length > 2) return text;
    }
    return document.body.innerText?.trim()?.slice(0, 100) || '';
  });
}

async function extractCurrentStep(page) {
  return page.evaluate(() => {
    const titleSelectors = ['h1', 'h2', '[class*="question"]', '[class*="title"]', '[class*="heading"]'];
    let title = '';
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      const text = el?.innerText?.trim();
      if (text && text.length > 2) { title = text; break; }
    }

    const subtitleSelectors = ['[class*="subtitle"]', '[class*="description"]', 'p:not(:empty)'];
    let subtitle = '';
    for (const sel of subtitleSelectors) {
      const el = document.querySelector(sel);
      const text = el?.innerText?.trim();
      if (text && text.length > 2 && text !== title) { subtitle = text; break; }
    }

    const optionSelectors = [
      '[class*="option"]:not([class*="selected"]):not([disabled])', '[class*="choice"]',
      '[class*="answer"]', '[class*="alternative"]', '[role="radio"]', '[role="checkbox"]',
    ];
    let options = [];
    for (const sel of optionSelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      const texts = els
        .map((el) => ({ text: el.innerText?.trim().replace(/\s+/g, ' '), imageUrl: el.querySelector('img')?.src || null }))
        .filter((o) => o.text && o.text.length > 0 && o.text.length < 300);
      if (texts.length >= 2) { options = texts; break; }
    }

    const heroSelectors = ['[class*="hero"] img', '[class*="banner"] img', '[class*="step-image"] img', 'header img'];
    let heroImageUrl = null;
    for (const sel of heroSelectors) {
      const img = document.querySelector(sel);
      if (img?.src?.startsWith('http')) { heroImageUrl = img.src; break; }
    }

    const hasEmail = !!document.querySelector('input[type="email"], input[name*="email" i], input[placeholder*="email" i]');
    const hasName = !!document.querySelector('input[name*="name" i], input[name*="nome" i], input[placeholder*="nome" i]');
    const hasForm = hasEmail || hasName;

    let type = 'content';
    if (hasForm) type = 'lead-capture';
    else if (options.length >= 2) type = 'single-choice';

    const bodyText = document.body.innerText.toLowerCase();
    const endKeywords = ['obrigado', 'parabéns', 'resultado', 'thank you', 'conclusão', 'finalizado'];
    const isEnd = endKeywords.some((k) => bodyText.includes(k)) && options.length === 0;

    let leadFields = [];
    if (hasForm) {
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"])').forEach((input) => {
        const label = input.labels?.[0]?.innerText?.trim() || input.placeholder?.trim() || input.name || '';
        const t = (input.type || '').toLowerCase();
        const n = (input.name || '').toLowerCase();
        const p = (input.placeholder || '').toLowerCase();
        let fieldType = 'custom';
        if (t === 'email' || n.includes('email') || p.includes('email')) fieldType = 'email';
        else if (n.includes('nome') || n.includes('name') || p.includes('nome')) fieldType = 'name';
        else if (n.includes('phone') || n.includes('fone') || n.includes('whatsapp') || p.includes('telefone')) fieldType = 'phone';
        leadFields.push({ label, fieldType });
      });
    }

    return { title, subtitle, options, heroImageUrl, type, isEnd, leadFields };
  });
}

async function advanceToNextStep(page, stepData) {
  if (stepData.type === 'single-choice' || stepData.type === 'multiple-choice') {
    const clicked = await page.evaluate(() => {
      const optionSelectors = [
        '[class*="option"]:not([class*="selected"]):not([disabled])', '[class*="choice"]:not([disabled])',
        '[class*="answer"]:not([disabled])', '[role="radio"]:not([disabled])', '[role="checkbox"]:not([disabled])',
      ];
      for (const sel of optionSelectors) {
        const el = Array.from(document.querySelectorAll(sel)).find((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (el) { el.click(); return true; }
      }
      return false;
    });
    if (clicked) await delay(1200);
  }

  if (stepData.type === 'lead-capture') {
    await page.evaluate(() => {
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"])').forEach((input) => {
        const t = (input.type || '').toLowerCase();
        const n = (input.name || '').toLowerCase();
        const p = (input.placeholder || '').toLowerCase();
        let val = 'Clone';
        if (t === 'email' || n.includes('email') || p.includes('email')) val = 'clone@exemplo.com';
        else if (n.includes('nome') || n.includes('name') || p.includes('nome')) val = 'Clone Quiz';
        else if (n.includes('phone') || n.includes('fone') || p.includes('telefone') || p.includes('whatsapp')) val = '11999999999';
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
    await delay(500);
  }

  const buttonClicked = await page.evaluate(() => {
    function isVisible(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    function isDisabled(el) { return el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') != null; }
    function tryClick(el) { if (el && isVisible(el) && !isDisabled(el)) { el.click(); return true; } return false; }

    const skipWords = ['back', 'voltar', 'prev', 'anterior', 'close', 'fechar', 'cancel', 'cancelar', 'skip', 'pular'];
    const advanceWords = ['começar', 'iniciar', 'continuar', 'avançar', 'próximo', 'next', 'start', 'continue', 'prosseguir', 'enviar', 'submit', 'ok'];
    const classKws = ['continue', 'continuar', 'next', 'proximo', 'advance', 'start', 'iniciar', 'primary', 'cta', 'submit'];

    for (const tag of ['button', 'a', '[role="button"]']) {
      for (const kw of classKws) {
        if (tryClick(document.querySelector(`${tag}[class*="${kw}"]`))) return true;
      }
    }
    if (tryClick(document.querySelector('button[type="submit"], input[type="submit"]'))) return true;

    const candidates = Array.from(document.querySelectorAll('button:not([disabled]), a, [role="button"], [class*="btn"]:not([disabled])'));
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || '').toLowerCase().trim();
      if (advanceWords.some((w) => text.includes(w)) && isVisible(el) && !isDisabled(el)) {
        el.click(); return true;
      }
    }
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || '').toLowerCase().trim();
      const cls = (el.className || '').toLowerCase();
      if (!skipWords.some((w) => text.includes(w) || cls.includes(w)) && isVisible(el) && !isDisabled(el)) {
        el.click(); return true;
      }
    }
    return false;
  });

  if (buttonClicked) { await delay(stepData.type === 'content' ? 3000 : 1500); return true; }
  return false;
}

// ─── Extract visual theme ──────────────────────────────────────────────────────
async function extractVisual(page) {
  return page.evaluate(() => {
    const rootStyle = window.getComputedStyle(document.documentElement);
    const cssVarNames = ['--primary', '--primary-color', '--color-primary', '--accent-color', '--theme-color', '--button-color', '--brand-color'];
    const cssVars = {};
    cssVarNames.forEach((v) => { const val = rootStyle.getPropertyValue(v).trim(); if (val) cssVars[v] = val; });

    const btn = document.querySelector('button:not([disabled])') || document.querySelector('[class*="option"]');
    const btnStyle = btn ? window.getComputedStyle(btn) : null;
    const h1 = document.querySelector('h1') || document.querySelector('h2');
    const fontFamily = (h1 ? window.getComputedStyle(h1) : window.getComputedStyle(document.body)).fontFamily;
    const logo = document.querySelector('img[class*="logo"], [class*="logo"] img, header img, [class*="header"] img');

    const colorFreq = {};
    document.querySelectorAll('*').forEach((el) => {
      const s = window.getComputedStyle(el);
      [s.backgroundColor, s.color].forEach((c) => {
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent' && c !== 'rgb(0, 0, 0)' && c !== 'rgb(255, 255, 255)') {
          colorFreq[c] = (colorFreq[c] || 0) + 1;
        }
      });
    });
    const topColors = Object.entries(colorFreq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);

    return {
      cssVars, topColors, fontFamily,
      primaryButtonBg: btnStyle?.backgroundColor || null,
      primaryButtonColor: btnStyle?.color || null,
      primaryButtonRadius: btnStyle?.borderRadius || null,
      logoUrl: logo?.src || null,
      title: document.title,
    };
  });
}

// ─── Main render route ─────────────────────────────────────────────────────────
app.post('/render', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');

    // Inject interception code BEFORE page loads
    await page.evaluateOnNewDocument(INTERCEPT_SCRIPT);

    // Block media to speed up
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.resourceType() === 'media') r.abort();
      else r.continue();
    });

    console.log(`[render] Loading: ${parsedUrl}`);
    await page.goto(parsedUrl.toString(), { waitUntil: 'networkidle0', timeout: 45000 });
    await delay(3000); // Wait for React hydration + AES decrypt

    const visual = await extractVisual(page);

    // ── Strategy 1: CryptoJS / fetch interception ──
    const captured = await page.evaluate(() => window.__quizCapture);
    if (captured?.data) {
      console.log(`[render] Strategy 1 (${captured.source}): captured quiz data directly`);
      const mappedSteps = mapCapturedSteps(captured.data);
      if (mappedSteps && mappedSteps.length > 0) {
        // Take one screenshot for all steps (no navigation needed)
        const screenshot = await page.screenshot({ encoding: 'base64', clip: { x: 0, y: 0, width: 390, height: 844 } });
        const steps = mappedSteps.map((s) => ({ ...s, screenshot }));

        console.log(`[render] Done via interception. ${steps.length} steps.`);
        await browser.close();
        return res.json({ success: true, steps, visual, title: visual.title || parsedUrl.hostname, summary: `${steps.length} steps captured via data interception` });
      }
    }

    // ── Strategy 2: React fiber extraction ──
    console.log('[render] Strategy 2: trying React fiber extraction...');
    const fiberData = await extractFromReactFiber(page);
    if (fiberData) {
      const mappedSteps = mapCapturedSteps(fiberData);
      if (mappedSteps && mappedSteps.length > 0) {
        const screenshot = await page.screenshot({ encoding: 'base64', clip: { x: 0, y: 0, width: 390, height: 844 } });
        const steps = mappedSteps.map((s) => ({ ...s, screenshot }));

        console.log(`[render] Done via React fiber. ${steps.length} steps.`);
        await browser.close();
        return res.json({ success: true, steps, visual, title: visual.title || parsedUrl.hostname, summary: `${steps.length} steps captured via React state` });
      }
    }

    // ── Strategy 3: Puppeteer navigation (universal fallback) ──
    console.log('[render] Strategy 3: navigating step-by-step...');
    const steps = [];
    const MAX_STEPS = 40;
    let previousSignature = null;
    let stuckCount = 0;

    for (let i = 0; i < MAX_STEPS; i++) {
      await waitForStable(page, 5000);
      const signature = await getCurrentStepSignature(page);

      if (signature === previousSignature) {
        stuckCount++;
        if (stuckCount >= 3) { console.log(`[render] Stuck at step ${i}, stopping.`); break; }
        await delay(2000);
        await advanceToNextStep(page, steps[steps.length - 1] || { type: 'content' });
        continue;
      }
      stuckCount = 0;
      previousSignature = signature;

      const stepData = await extractCurrentStep(page);
      console.log(`[render] Step ${i + 1}: type=${stepData.type} title="${stepData.title?.slice(0, 50)}"`);

      if (!stepData.title && steps.length > 0) { console.log('[render] Empty step, stopping.'); break; }

      const screenshot = await page.screenshot({ encoding: 'base64', clip: { x: 0, y: 0, width: 390, height: 844 } });
      steps.push({ ...stepData, screenshot });

      if (stepData.isEnd) { console.log(`[render] End state at step ${i + 1}.`); break; }

      const advanced = await advanceToNextStep(page, stepData);
      if (!advanced) { console.log(`[render] Could not advance from step ${i + 1}, stopping.`); break; }

      await delay(1000);
    }

    await browser.close();
    browser = null;

    console.log(`[render] Done via navigation. ${steps.length} steps.`);
    res.json({ success: true, steps, visual, title: visual.title || parsedUrl.hostname, summary: `${steps.length} steps captured via navigation` });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[render] Error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to render page' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quiz Cloner Service on :${PORT}`));
