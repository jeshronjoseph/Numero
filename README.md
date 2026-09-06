# Numero

Chrome extension that spells out Google calculator results in words. Toggle between International (Million/Billion) and Indian (Lakh/Crore) formats.

## Installation

1. Clone/download this repo
2. Go to `chrome://extensions`, turn on Developer mode
3. Click "Load unpacked", select this folder
4. Search a calculation on Google, e.g. `62^6`

## Features

- Full words for the result (e.g. "Fifty-Six Billion Eight Hundred Million...")
- Short form always shown too (e.g. "56.80 Billion")
- Toggle between **International** and **Indian** numbering, saved across sessions
- Decimals and negative numbers
- One-click copy of the full words text
- Long results collapse to one line with a click-to-expand arrow

## Notes

- Detection scans for the largest-font numeric text on the page, since Google's class names change often
- Results shown in scientific notation lose precision beyond the displayed digits — these are marked "(approx)"

## Files

- `manifest.json` — extension config (Manifest V3)
- `content.js` — detection, number-to-words conversion, UI
- `icons/` — icon at 16/32/48/128 px, plus SVG source