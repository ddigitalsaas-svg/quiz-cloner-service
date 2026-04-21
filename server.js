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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until page title/content stabilizes (no DOM mutations for 600ms)
async function waitForStable(page, timeout = 8000) {
  await Promise.race([
    page.evaluate(() => new Promise((resolve) => {
      let timer;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(resolve, 600);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      // Safety: resolve after 4s even if still mutating
      setTimeout(resolve, 4000);
    })),
    delay(timeout),
  ]);
}

// Get the primary visible text of the current step
async function getCurrentStepSignature(page) {
  return page.evaluate(() => {
    const selectors = [
      'h1', 'h2',
      '[class*="question"]', '[class*="title"]', '[class*="step-title"]',
      '[class*="quiz-title"]', '[class*="pergunta"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.innerText?.trim();
        if (text && text.length > 2) return text;
      }
    }
    // Fallback: first meaningful text node
    return document.body.innerText?.trim()?.slice(0, 100) || '';
  });
}

// Extract all data from the currently visible step
async function extractCurrentStep(page) {
  return page.evaluate(() => {
    // ── Title ──
    const titleSelectors = [
      'h1', 'h2',
      '[class*="question"]', '[class*="title"]',
      '[class*="quiz-title"]', '[class*="step-title"]',
      '[class*="heading"]',
    ];
    let title = '';
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      const text = el?.innerText?.trim();
      if (text && text.length > 2) { title = text; break; }
    }

    // ── Subtitle / description ──
    const subtitleSelectors = [
      '[class*="subtitle"]', '[class*="description"]', '[class*="subheading"]',
      'p:not(:empty)',
    ];
    let subtitle = '';
    for (const sel of subtitleSelectors) {
      const el = document.querySelector(sel);
      const text = el?.innerText?.trim();
      if (text && text.length > 2 && text !== title) { subtitle = text; break; }
    }

    // ── Options ──
    const optionSelectors = [
      '[class*="option"]:not([class*="selected"]):not([disabled])',
      '[class*="choice"]',
      '[class*="answer"]',
      '[class*="alternative"]',
      '[role="radio"]', '[role="checkbox"]',
      '[class*="quiz-btn"]:not([class*="back"]):not([class*="prev"])',
    ];
    let options = [];
    for (const sel of optionSelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      const texts = els
        .map((el) => {
          const text = el.innerText?.trim().replace(/\s+/g, ' ');
          const img = el.querySelector('img');
          return text ? { text, imageUrl: img?.src || null } : null;
        })
        .filter((o) => o && o.text.length > 0 && o.text.length < 300);
      if (texts.length >= 2) { options = texts; break; }
    }

    // ── Hero image ──
    const heroSelectors = [
      '[class*="hero"] img', '[class*="banner"] img',
      '[class*="step-image"] img', '[class*="question-image"] img',
      'header img',
    ];
    let heroImageUrl = null;
    for (const sel of heroSelectors) {
      const img = document.querySelector(sel);
      if (img?.src && img.src.startsWith('http')) { heroImageUrl = img.src; break; }
    }

    // ── Step type detection ──
    const hasEmailInput = !!document.querySelector(
      'input[type="email"], input[name*="email" i], input[placeholder*="email" i]'
    );
    const hasNameInput = !!document.querySelector(
      'input[name*="name" i], input[name*="nome" i], input[placeholder*="nome" i]'
    );
    const hasForm = hasEmailInput || hasNameInput;

    let type = 'content';
    if (hasForm) {
      type = 'lead-capture';
    } else if (options.length >= 2) {
      type = 'single-choice';
    }

    // ── Is end state? ──
    const bodyText = document.body.innerText.toLowerCase();
    const endKeywords = [
      'obrigado', 'parabéns', 'resultado', 'thank you', 'thanks',
      'conclusão', 'finalizado', 'completed', 'uau', 'incrível',
    ];
    const isEnd = endKeywords.some((k) => bodyText.includes(k)) && options.length === 0;

    // ── Lead fields ──
    let leadFields = [];
    if (hasForm) {
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"])').forEach((input) => {
        const label =
          input.labels?.[0]?.innerText?.trim() ||
          input.placeholder?.trim() ||
          input.name || '';
        const t = (input.type || '').toLowerCase();
        const n = (input.name || '').toLowerCase();
        const p = (input.placeholder || '').toLowerCase();
        let fieldType = 'custom';
        if (t === 'email' || n.includes('email') || p.includes('email')) fieldType = 'email';
        else if (n.includes('nome') || n.includes('name') || p.includes('nome') || p.includes('name')) fieldType = 'name';
        else if (n.includes('phone') || n.includes('fone') || n.includes('whatsapp') || p.includes('telefone')) fieldType = 'phone';
        leadFields.push({ label, fieldType });
      });
    }

    return { title, subtitle, options, heroImageUrl, type, isEnd, leadFields };
  });
}

// Try to advance to the next step — returns true if an action was taken
async function advanceToNextStep(page, stepData) {
  // ── For CHOICE steps: click first option, then maybe continue ──
  if (stepData.type === 'single-choice' || stepData.type === 'multiple-choice') {
    const clicked = await page.evaluate(() => {
      const optionSelectors = [
        '[class*="option"]:not([class*="selected"]):not([disabled])',
        '[class*="choice"]:not([disabled])',
        '[class*="answer"]:not([disabled])',
        '[class*="alternative"]:not([disabled])',
        '[role="radio"]:not([disabled])',
        '[role="checkbox"]:not([disabled])',
      ];
      for (const sel of optionSelectors) {
        const els = Array.from(document.querySelectorAll(sel));
        const visible = els.find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (visible) {
          visible.click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      // Wait to see if quiz auto-advanced after clicking option
      await delay(1200);
      return true;
    }
  }

  // ── For LEAD CAPTURE: fill dummy data and submit ──
  if (stepData.type === 'lead-capture') {
    await page.evaluate(() => {
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"])').forEach((input) => {
        const t = (input.type || '').toLowerCase();
        const n = (input.name || '').toLowerCase();
        const p = (input.placeholder || '').toLowerCase();
        if (t === 'email' || n.includes('email') || p.includes('email')) {
          input.value = 'clone@exemplo.com';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (n.includes('nome') || n.includes('name') || p.includes('nome')) {
          input.value = 'Clone Quiz';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (n.includes('phone') || n.includes('fone') || p.includes('telefone') || p.includes('whatsapp')) {
          input.value = '11999999999';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          input.value = 'Clone';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    });
    await delay(500);
  }

  // ── Click the primary advance button (continue / next / start / submit) ──
  const buttonClicked = await page.evaluate(() => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function isDisabled(el) {
      return el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') != null;
    }
    function tryClick(el) {
      if (el && isVisible(el) && !isDisabled(el)) { el.click(); return true; }
      return false;
    }

    const skipWords = ['back', 'voltar', 'prev', 'anterior', 'close', 'fechar', 'cancel', 'cancelar', 'skip', 'pular'];

    // Priority selectors — buttons AND anchors AND divs with role=button
    const tagPrefixes = ['button', 'a', '[role="button"]', 'div', 'span'];
    const classKeywords = [
      'continue', 'continuar', 'next', 'proximo', 'próximo',
      'advance', 'avancar', 'avançar', 'start', 'comecar', 'começar',
      'iniciar', 'begin', 'primary', 'btn-main', 'cta', 'submit',
    ];

    for (const tag of tagPrefixes) {
      for (const kw of classKeywords) {
        const el = document.querySelector(`${tag}[class*="${kw}"]`);
        if (tryClick(el)) return true;
      }
    }

    // submit inputs/buttons
    for (const sel of ['button[type="submit"]', 'input[type="submit"]', 'a[type="submit"]']) {
      if (tryClick(document.querySelector(sel))) return true;
    }

    // Text-based match on buttons + anchors + role=button elements
    const candidates = Array.from(document.querySelectorAll(
      'button:not([disabled]), a[href], [role="button"], [class*="btn"]:not([disabled])'
    ));
    const advanceWords = ['começar', 'iniciar', 'continuar', 'avançar', 'próximo', 'next',
      'start', 'continue', 'prosseguir', 'enviar', 'submit', 'ok'];

    // First: try text-match advance words
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || '').toLowerCase().trim();
      if (advanceWords.some((w) => text.includes(w)) && isVisible(el) && !isDisabled(el)) {
        el.click();
        return true;
      }
    }

    // Last resort: first visible clickable element not in skip list
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || '').toLowerCase().trim();
      const cls = (el.className || '').toLowerCase();
      const isBad = skipWords.some((w) => text.includes(w) || cls.includes(w));
      if (!isBad && isVisible(el) && !isDisabled(el)) {
        el.click();
        return true;
      }
    }

    return false;
  });

  if (buttonClicked) {
    await delay(stepData.type === 'content' ? 3000 : 1500);
    return true;
  }

  return false;
}

// ─── Main render + navigate route ─────────────────────────────────────────────

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

    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );

    // Block fonts/media to speed up — keep images and scripts
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.resourceType() === 'media') r.abort();
      else r.continue();
    });

    console.log(`[render] Loading: ${parsedUrl}`);
    await page.goto(parsedUrl.toString(), { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for React hydration + possible AES decryption (Inlead)
    await delay(4000);
    await waitForStable(page, 6000);

    console.log('[render] Page ready. Starting step navigation...');

    // ── Extract global visual theme (once, from initial state) ──
    const visual = await page.evaluate(() => {
      const rootStyle = window.getComputedStyle(document.documentElement);
      const cssVarNames = [
        '--primary', '--primary-color', '--color-primary', '--accent-color',
        '--theme-color', '--theme-featured-color', '--featured-color',
        '--button-color', '--brand-color', '--main-color',
      ];
      const cssVars = {};
      cssVarNames.forEach((v) => {
        const val = rootStyle.getPropertyValue(v).trim();
        if (val) cssVars[v] = val;
      });

      const btn = document.querySelector('button:not([disabled])') ||
        document.querySelector('[class*="option"]');
      const btnStyle = btn ? window.getComputedStyle(btn) : null;

      const h1 = document.querySelector('h1') || document.querySelector('h2');
      const fontFamily = (h1 ? window.getComputedStyle(h1) : window.getComputedStyle(document.body)).fontFamily;

      const logo = document.querySelector(
        'img[class*="logo"], [class*="logo"] img, header img, [class*="header"] img'
      );

      const allImages = Array.from(document.querySelectorAll('img'))
        .map((img) => ({ src: img.src, w: img.naturalWidth }))
        .filter((img) => img.src.startsWith('http'))
        .sort((a, b) => b.w - a.w);

      // Frequency of colors on page
      const colorFreq = {};
      document.querySelectorAll('*').forEach((el) => {
        const s = window.getComputedStyle(el);
        [s.backgroundColor, s.color].forEach((c) => {
          if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent' &&
              c !== 'rgb(0, 0, 0)' && c !== 'rgb(255, 255, 255)') {
            colorFreq[c] = (colorFreq[c] || 0) + 1;
          }
        });
      });
      const topColors = Object.entries(colorFreq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);

      return {
        cssVars,
        topColors,
        fontFamily,
        primaryButtonBg: btnStyle?.backgroundColor || null,
        primaryButtonColor: btnStyle?.color || null,
        primaryButtonRadius: btnStyle?.borderRadius || null,
        logoUrl: logo?.src || null,
        backgroundColor: window.getComputedStyle(document.body).backgroundColor,
        images: allImages.slice(0, 20),
        title: document.title,
      };
    });

    // ── Navigate through ALL steps ──
    const steps = [];
    const MAX_STEPS = 40;
    let previousSignature = null;
    let stuckCount = 0;

    for (let i = 0; i < MAX_STEPS; i++) {
      await waitForStable(page, 5000);

      const signature = await getCurrentStepSignature(page);

      // Detect if stuck on same step
      if (signature === previousSignature) {
        stuckCount++;
        if (stuckCount >= 3) {
          console.log(`[render] Stuck on step ${i}, stopping.`);
          break;
        }
        // Try clicking again with longer wait
        await delay(2000);
        await advanceToNextStep(page, steps[steps.length - 1] || { type: 'content' });
        continue;
      }
      stuckCount = 0;
      previousSignature = signature;

      // Extract current step data
      const stepData = await extractCurrentStep(page);
      console.log(`[render] Step ${i + 1}: type=${stepData.type} title="${stepData.title?.slice(0, 50)}"`);

      if (!stepData.title && steps.length > 0) {
        console.log('[render] Empty step, stopping.');
        break;
      }

      // Screenshot of this step
      const screenshot = await page.screenshot({
        encoding: 'base64',
        clip: { x: 0, y: 0, width: 390, height: 844 },
      });

      steps.push({ ...stepData, screenshot });

      // Stop if this is a known end state
      if (stepData.isEnd) {
        console.log(`[render] End state detected at step ${i + 1}.`);
        break;
      }

      // Advance to next step
      const advanced = await advanceToNextStep(page, stepData);
      if (!advanced) {
        console.log(`[render] Could not advance from step ${i + 1}, stopping.`);
        break;
      }

      // Extra wait for slow transitions/animations
      await delay(1000);
    }

    await browser.close();
    browser = null;

    console.log(`[render] Done. Captured ${steps.length} steps.`);

    // First step HTML for Claude (text content extraction)
    const firstScreenshotHtml = steps.length > 0
      ? `Quiz "${visual.title}" com ${steps.length} etapas capturadas:\n` +
        steps.map((s, i) =>
          `ETAPA ${i + 1} (${s.type}): "${s.title}" | opções: ${(s.options || []).map(o => o.text).join(', ')}`
        ).join('\n')
      : '';

    res.json({
      success: true,
      steps, // All steps with individual screenshots
      visual,
      title: visual.title || parsedUrl.hostname,
      summary: firstScreenshotHtml,
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[render] Error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to render page' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Quiz Cloner Service on :${PORT}`));
