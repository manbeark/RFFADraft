# RFFA Draft Room

A local, browser-based fantasy football draft board for a 12-team PPR snake draft. It imports team names from ESPN, uses ESPN's 2026 PPR player pool (including kickers and D/ST), has no pick timer, recovers every pick from browser storage, and mirrors the draft into a Google Sheet.

## Start it

1. Double-click `start-draft-room.bat`.
2. Your browser opens to **http://localhost:8765**.
3. Leave the black terminal window open during the draft. Closing it stops the local app, but completed picks remain saved in the browser.

No package installation is required. The app runs on the Python 3.8+ installation already present on this computer.

You can also start it from PowerShell:

```powershell
py server.py
```

## Draft-night setup

1. Enter the 2026 ESPN league ID and click **Import ESPN teams**.
2. If the league is private, expand **Private league credentials** and supply `SWID` and `espn_s2` from a browser currently signed into ESPN. The app sends them only from this computer to ESPN and does not save them.
3. Drag teams or use the arrow buttons to set the draft order.
4. Connect Google and choose the destination spreadsheet.
5. Click **Enter draft room**.
6. Use **Draft** next to a player, then confirm the pick. The selection appears immediately on the position-colored draft board.

The app automatically snakes the order each round. **Undo** reverses the last pick. **CSV** downloads a separate backup at any time.

The live room defaults to the high-contrast **Outdoor** display for daylight TVs. Use the moon/sun button in the top-right controls to switch between Outdoor and Dark display modes; the choice is saved locally.

## One-time Google setup

Google requires an OAuth client so this local page can show and update your spreadsheets.

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable **Google Drive API** and **Google Sheets API**.
4. Configure the OAuth consent screen. If the app is in Testing, add the Google account used on draft night as a test user.
5. Create an OAuth Client ID with application type **Web application**.
6. Add `http://localhost:8765` under **Authorized JavaScript origins**. No redirect URI is needed.
7. Copy the client ID ending in `.apps.googleusercontent.com` into the draft-room setup screen.

The client ID is saved locally for convenience; it is not a secret. Google access tokens remain only in memory and normally need reconnection if the page has been open for about an hour.

## Reliability notes

- `data/players-2026.json` is the local ESPN player cache. The setup-screen player badge can be clicked to refresh it.
- Picks and setup state are written to browser `localStorage` after every action.
- Google Sheet sync rewrites the dedicated `RFFA Draft …` tab from current local state. This makes reconnects and undo operations safe from duplicate rows.
- If Google disconnects, keep drafting. Picks continue saving locally; reconnect Google from Setup and the tab catches up.
- Google API writes are routed through the local Python server to avoid browser cross-origin failures. OAuth tokens are used only in memory and are never written to disk.
- If ESPN import fails on draft night, **Use 12 manual teams** creates editable team names.

## Test it before draft day

Run:

```powershell
py -m unittest discover -v
```

Then do a short mock draft: make several picks, undo one, reload the page, reconnect Google, and confirm the same picks appear in the selected Sheet.
