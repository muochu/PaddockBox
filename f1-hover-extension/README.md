# F1 Hover Stats Chrome Extension

A lightweight Chrome (MV3) extension that highlights Formula 1 driver names on any webpage and shows a rich popup with their biography plus season-by-season performance pulled from the Ergast API.

## Features

- **Dynamic driver detection**: Automatically fetches the current F1 drivers list from the Ergast API on extension load (cached for 24 hours), so the extension stays up-to-date without manual updates.
- Automatically scans any page (including dynamically injected content) for F1 driver names and wraps them with an accessible inline badge.
- On hover or keyboard focus, fetches live data via the extension background service worker from the HTTPS Ergast mirror (`https://api.jolpi.ca/ergast/f1/...`), caches the response, and renders:
  - Full name, nationality, driver code, and date of birth.
  - Career summary (seasons raced, total wins, championship titles, active years).
  - Last ten seasons with team(s), finishing position, total points, and wins.
- Popup follows the cursor, stays within viewport bounds, and dismisses instantly when focus leaves.
- Written in vanilla JavaScript + CSS for zero dependencies.

## File Structure

```
f1-hover-extension/
├── manifest.json   # Chrome MV3 manifest
├── background.js   # Service worker proxy for Ergast API calls
├── content.js      # DOM scanner, Ergast client, popup renderer
├── style.css       # Driver highlight + popup styles
└── README.md
```

## Development & Testing

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**, then select the `f1-hover-extension` folder.
4. Navigate to any page containing F1 driver names (e.g., news article) and hover over the highlighted text.

## Customizing

- The drivers list is automatically fetched from the Ergast HTTPS mirror (current season drivers, with fallback to last 3 seasons, plus an offline fallback list). No manual updates needed!
- Adjust popup styling in `style.css` (colors, layout, typography).
- Extend `handleDriverRequest` in `background.js` to pull extra metrics (race wins per season, constructors, etc.) by chaining more Ergast endpoints.

## Production Tips

- When ready to publish, bump the `version` in `manifest.json`, zip the folder contents, and upload the archive to the Chrome Web Store dashboard.
- You can optionally add icons by dropping PNGs (16, 32, 48, 128px) into the folder and referencing them via the `icons` key in `manifest.json`.
- Keep API usage polite: Ergast is free but rate-limited (~4 requests per second). The built-in caching layer already minimizes duplicate calls per driver per page load.
