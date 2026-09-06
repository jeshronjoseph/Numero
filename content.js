(function () {
  'use strict';

  // ---------- Config ----------
  const STORAGE_KEY = 'calcWordsSystem'; // 'INTL' | 'IND'
  const MIN_DIGITS = 1;          // calculator results can be short (e.g. 5*5 = 25)
  const MIN_FONT_SIZE = 20;      // px — calculator result is rendered large
  const DEBOUNCE_MS = 250;

  let currentSystem = 'INTL';
  let hostEl = null;
  let shadow = null;
  let lastResultEl = null;
  let lastRawText = null;
  let debounceTimer = null;

  // ---------- Word data ----------
  const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
    'Eighteen', 'Nineteen'];
  const DIGIT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const SCALE_INTL = ['', 'Thousand', 'Million', 'Billion', 'Trillion', 'Quadrillion',
    'Quintillion', 'Sextillion', 'Septillion', 'Octillion', 'Nonillion', 'Decillion'];

  const SCALE_IND_BASE = ['', 'Thousand', 'Lakh']; // below 1 Crore; Crore+ handled recursively
  const CRORE = 10000000n;
  const CRORE_NUM = 1e7;

  // ---------- Small-number helpers ----------
  function twoDigitWords(n) {
    if (n < 20) return ONES[n];
    const t = Math.floor(n / 10), o = n % 10;
    return TENS[t] + (o ? '-' + ONES[o] : '');
  }

  function threeDigitWords(n) {
    const hundred = Math.floor(n / 100);
    const rest = n % 100;
    let str = '';
    if (hundred) str += ONES[hundred] + ' Hundred';
    if (rest) str += (str ? ' ' : '') + twoDigitWords(rest);
    return str;
  }

  // ---------- Full spell-out ----------
  function toWordsIntl(bi) {
    if (bi === 0n) return 'Zero';
    const negative = bi < 0n;
    if (negative) bi = -bi;
    const groups = [];
    while (bi > 0n) { groups.push(Number(bi % 1000n)); bi /= 1000n; }
    if (groups.length - 1 >= SCALE_INTL.length) return null; // too large
    const parts = [];
    for (let i = groups.length - 1; i >= 0; i--) {
      if (!groups[i]) continue;
      parts.push(threeDigitWords(groups[i]) + (SCALE_INTL[i] ? ' ' + SCALE_INTL[i] : ''));
    }
    return (negative ? 'Minus ' : '') + parts.join(' ');
  }

  function toWordsIndianBase(bi) {
    // bi is guaranteed 0 <= bi < 1 Crore here
    if (bi === 0n) return '';
    let s = bi.toString();
    const groups = [];
    if (s.length > 3) {
      groups.push(s.slice(-3));
      s = s.slice(0, -3);
      while (s.length > 0) {
        if (s.length <= 2) { groups.push(s); s = ''; }
        else { groups.push(s.slice(-2)); s = s.slice(0, -2); }
      }
    } else {
      groups.push(s);
    }
    const parts = [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const num = parseInt(groups[i], 10);
      if (!num) continue;
      const words = i === 0 ? threeDigitWords(num) : twoDigitWords(num);
      parts.push(words + (SCALE_IND_BASE[i] ? ' ' + SCALE_IND_BASE[i] : ''));
    }
    return parts.join(' ');
  }

  function toWordsIndian(bi) {
    if (bi === 0n) return 'Zero';
    const negative = bi < 0n;
    if (negative) bi = -bi;
    let result;
    if (bi >= CRORE) {
      const higher = bi / CRORE;
      const lower = bi % CRORE;
      result = toWordsIndian(higher) + ' Crore';
      if (lower > 0n) result += ' ' + toWordsIndianBase(lower);
    } else {
      result = toWordsIndianBase(bi);
    }
    return (negative ? 'Minus ' : '') + result;
  }

  // ---------- Fractional part ----------
  function fracToWords(fracPart) {
    if (!fracPart) return '';
    const digitsWords = fracPart.split('').map(d => DIGIT_WORDS[parseInt(d, 10)]).join(' ');
    return ' Point ' + digitsWords;
  }

  // ---------- Short scale ----------
  function shortScaleIntl(numAbs) {
    for (let i = SCALE_INTL.length - 1; i >= 1; i--) {
      const div = Math.pow(1000, i);
      if (numAbs >= div) return (numAbs / div).toFixed(2) + ' ' + SCALE_INTL[i];
    }
    return null; // below 1000, no abbreviation needed
  }

  function shortScaleIndian(numAbs) {
    if (numAbs < 1000) return null;
    if (numAbs < 1e5) return (numAbs / 1e3).toFixed(2) + ' Thousand';
    if (numAbs < CRORE_NUM) return (numAbs / 1e5).toFixed(2) + ' Lakh';
    const croreValue = numAbs / CRORE_NUM;
    if (croreValue < 1e5) return croreValue.toFixed(2) + ' Crore'; // plain up to ~1 Lakh Crore
    return shortScaleIndian(croreValue) + ' Crore'; // compounds: Lakh Crore, Thousand Crore, etc.
  }

  const PLAIN_NUM_RE = /^-?[\d,]+(\.\d+)?$/;
  const SCI_NUM_RE = /^-?\d+(\.\d+)?e[+-]?\d+$/i;

  // ---------- Parsing the on-page number ----------
  function parsePlainNumber(text) {
    const negative = text.startsWith('-');
    const clean = text.replace(/^-/, '').replace(/,/g, '');
    const [intPart, fracPart] = clean.split('.');
    if (!intPart) return null;
    let bi;
    try { bi = BigInt(intPart); } catch (e) { return null; }
    const floatAbs = parseFloat(clean);
    if (negative) bi = -bi;
    return { bi, fracPart: fracPart || '', negative, approx: false, floatAbs };
  }

  // Reconstructs a best-effort integer from Google's scientific-notation display
  // (e.g. "3.5216146e+12" -> 3521614600000). Precision beyond the digits Google
  // showed is unrecoverable, so the caller marks this result as approximate.
  function parseScientificNumber(text) {
    const negative = text.startsWith('-');
    const body = text.replace(/^-/, '');
    const match = body.match(/^(\d+)(?:\.(\d+))?e\+?(\d+)$/i);
    if (!match) return null;
    const wholeDigits = match[1];
    const fracDigits = match[2] || '';
    const exponent = parseInt(match[3], 10);
    const allDigits = wholeDigits + fracDigits;
    const pointPos = wholeDigits.length + exponent; // digits before the decimal point after shifting
    let intStr;
    if (pointPos >= allDigits.length) {
      intStr = allDigits + '0'.repeat(pointPos - allDigits.length);
    } else {
      intStr = allDigits.slice(0, pointPos) || '0';
    }
    let bi;
    try { bi = BigInt(intStr); } catch (e) { return null; }
    const floatAbs = Number(bi);
    if (negative) bi = -bi;
    return { bi, fracPart: '', negative, approx: true, floatAbs };
  }

  function parseResultText(raw) {
    const text = raw.trim();
    if (PLAIN_NUM_RE.test(text)) return parsePlainNumber(text);
    if (SCI_NUM_RE.test(text)) return parseScientificNumber(text);
    return null;
  }

  function buildOutput(parsed, system) {
    const { bi, negative, approx, fracPart, floatAbs } = parsed;

    const shortForm = system === 'IND' ? shortScaleIndian(floatAbs) : shortScaleIntl(floatAbs);
    const fullWords = system === 'IND' ? toWordsIndian(bi) : toWordsIntl(bi);
    const suffix = approx ? ' (approx)' : '';

    return {
      short: shortForm ? (negative ? 'Minus ' : '') + shortForm + suffix : null,
      full: (fullWords === null
        ? 'Number is too large to spell out in full.'
        : fullWords + fracToWords(fracPart)) + suffix
    };
  }

  function findCardContainer(resultEl) {
    const acEl = Array.from(document.querySelectorAll('div, span, button'))
      .find(el => el.children.length === 0 && el.textContent.trim() === 'AC' && el.offsetParent !== null);

    if (acEl) {
      let node = resultEl;
      while (node && node !== document.body) {
        if (node.contains(acEl)) return node;
        node = node.parentElement;
      }
    }

    let node = resultEl;
    while (node.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement;
      if (Math.abs(parent.offsetWidth - node.offsetWidth) > 40) break;
      node = parent;
    }
    return node;
  }

  // ---------- Finding the calculator result on the page ----------
  function findResultElement() {
    const nodes = document.querySelectorAll('div, span');
    let best = null, bestFontSize = 0;
    for (const el of nodes) {
      if (el.children.length > 0) continue; // leaf nodes only
      if (hostEl && hostEl.contains(el)) continue; 
      const text = el.textContent.trim();
      const isPlain = PLAIN_NUM_RE.test(text);
      const isSci = SCI_NUM_RE.test(text);
      if (!isPlain && !isSci) continue;
      if (isPlain && text.replace(/[^0-9]/g, '').length < MIN_DIGITS) continue;
      if (el.offsetParent === null) continue; // hidden
      const fontSize = parseFloat(window.getComputedStyle(el).fontSize);
      if (fontSize > bestFontSize) { bestFontSize = fontSize; best = el; }
    }
    return bestFontSize >= MIN_FONT_SIZE ? best : null;
  }

  // ---------- UI ----------
  function ensureHost(resultEl) {
    if (hostEl && document.contains(hostEl) && lastResultEl === resultEl) return;
    if (hostEl) hostEl.remove();

    // Finds the calculator's outer card by locating the common ancestor of the
    // result number and the "AC" button — both always live inside the same card,
    // so this pins down the true boundary without relying on Google's (unstable)
    // class names. Falls back to a width-jump check if AC can't be found.
    const card = findCardContainer(resultEl);
    hostEl = document.createElement('div');
    hostEl.style.all = 'initial';
    hostEl.style.display = 'block';
    card.parentNode.insertBefore(hostEl, card);
    shadow = hostEl.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          font-family: Roboto, Arial, sans-serif;
          margin: 4px 0 8px 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .row {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .short {
          font-size: 15px;
          color: #8ab4f8;
          font-weight: 500;
        }
        .toggle {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: #9aa0a6;
          cursor: pointer;
          user-select: none;
        }
        .switch {
          position: relative;
          width: 34px;
          height: 18px;
          background: #5f6368;
          border-radius: 10px;
          transition: background .15s ease;
        }
        .switch.on { background: #8ab4f8; }
        .knob {
          position: absolute;
          top: 2px; left: 2px;
          width: 14px; height: 14px;
          background: #fff;
          border-radius: 50%;
          transition: transform .15s ease;
        }
        .switch.on .knob { transform: translateX(16px); }
        .copy {
          cursor: pointer;
          font-size: 12px;
          color: #9aa0a6;
          border: 1px solid #5f6368;
          border-radius: 4px;
          padding: 1px 6px;
        }
        .copy:hover { color: #e8eaed; border-color: #9aa0a6; }
        .fullwrap {
          display: flex;
          align-items: flex-start;
          gap: 6px;
          cursor: pointer;
        }
        .full {
          font-size: 13px;
          color: #bdc1c6;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 1;
          -webkit-box-orient: vertical;
        }
        .full.expanded {
          -webkit-line-clamp: unset;
        }
        .arrow {
          flex: none;
          margin-top: 2px;
          width: 10px; height: 10px;
          border-right: 2px solid #9aa0a6;
          border-bottom: 2px solid #9aa0a6;
          transform: rotate(45deg);
          transition: transform .15s ease;
        }
        .arrow.expanded { transform: rotate(-135deg); }
      </style>
      <div class="wrap">
        <div class="row">
          <span class="short"></span>
          <span class="copy" title="Copy full number in words">Copy</span>
          <span class="toggle">
            <span>INTL</span>
            <span class="switch"><span class="knob"></span></span>
            <span>IND</span>
          </span>
        </div>
        <div class="fullwrap">
          <span class="arrow"></span>
          <span class="full"></span>
        </div>
      </div>
    `;

    const switchEl = shadow.querySelector('.switch');
    const toggleEl = shadow.querySelector('.toggle');
    const fullwrapEl = shadow.querySelector('.fullwrap');
    const fullEl = shadow.querySelector('.full');
    const arrowEl = shadow.querySelector('.arrow');
    const copyEl = shadow.querySelector('.copy');

    toggleEl.addEventListener('click', () => {
      currentSystem = currentSystem === 'INTL' ? 'IND' : 'INTL';
      chrome.storage.local.set({ [STORAGE_KEY]: currentSystem });
      switchEl.classList.toggle('on', currentSystem === 'IND');
      render(lastResultEl, true);
    });

    fullwrapEl.addEventListener('click', () => {
      fullEl.classList.toggle('expanded');
      arrowEl.classList.toggle('expanded');
    });

    copyEl.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(fullEl.textContent).then(() => {
        const original = copyEl.textContent;
        copyEl.textContent = 'Copied!';
        setTimeout(() => { copyEl.textContent = original; }, 1200);
      });
    });

    switchEl.classList.toggle('on', currentSystem === 'IND');
    lastResultEl = resultEl;
  }

  function render(resultEl, forceReparse) {
    if (!resultEl || !document.contains(resultEl)) return;
    const raw = resultEl.textContent.trim();
    if (!forceReparse && raw === lastRawText && lastResultEl === resultEl) return;
    lastRawText = raw;

    const parsed = parseResultText(raw);
    ensureHost(resultEl);
    const shortEl = shadow.querySelector('.short');
    const fullEl = shadow.querySelector('.full');

    if (!parsed) {
      hostEl.style.display = 'none';
      return;
    }
    hostEl.style.display = '';

    const out = buildOutput(parsed, currentSystem);
    shortEl.textContent = out.short || '';
    shortEl.style.display = out.short ? '' : 'none';
    fullEl.textContent = out.full;
  }

  function scan() {
    const el = findResultElement();
    if (el) render(el, false);
  }

  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, DEBOUNCE_MS);
  }

  // ---------- Init ----------
  chrome.storage.local.get([STORAGE_KEY], (data) => {
    if (data && data[STORAGE_KEY]) currentSystem = data[STORAGE_KEY];
    scan();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
})();
