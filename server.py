#!/usr/bin/env python3
"""Dependency-free local server for the RFFA fantasy football draft room."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Timer


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
HOST = "127.0.0.1"
DEFAULT_PORT = 8765
POSITION_IDS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}
PRO_TEAMS = {
    0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
    7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV",
    14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG",
    20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF",
    26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
}


def _espn_request(url: str, *, fantasy_filter=None, espn_s2="", swid=""):
    headers = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (RFFA Local Draft Room)",
    }
    if fantasy_filter:
        headers["X-Fantasy-Filter"] = json.dumps(fantasy_filter, separators=(",", ":"))
    cookies = []
    if espn_s2:
        cookies.append(f"espn_s2={espn_s2.strip()}")
    if swid:
        normalized = swid.strip()
        if normalized and not normalized.startswith("{"):
            normalized = "{" + normalized.strip("{}") + "}"
        cookies.append(f"SWID={normalized}")
    if cookies:
        headers["Cookie"] = "; ".join(cookies)
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=35) as response:
        return json.load(response)


def _google_request(url: str, access_token: str, *, method="GET", payload=None):
    """Call a narrowly scoped Google API endpoint without persisting the OAuth token."""
    if not access_token or len(access_token) > 4096:
        raise ValueError("Google connection is missing. Reconnect Google and try again.")
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "RFFA Local Draft Room",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        try:
            details = json.loads(exc.read().decode("utf-8"))
            message = details.get("error", {}).get("message") or details.get("error_description")
        except Exception:
            message = None
        if exc.code == 401:
            message = "Google authorization expired. Reconnect Google from Setup."
        elif exc.code == 403 and not message:
            message = "Google denied access. Confirm the Sheet is editable and both APIs are enabled."
        raise RuntimeError(message or f"Google API returned HTTP {exc.code}.") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"The local server could not reach Google: {exc.reason}") from None


def _google_file_id(value) -> str:
    file_id = str(value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{10,200}", file_id):
        raise ValueError("Invalid Google spreadsheet ID.")
    return file_id


def google_list_sheets(payload: dict) -> dict:
    query = urllib.parse.urlencode({
        "q": "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
        "orderBy": "modifiedTime desc",
        "pageSize": 100,
        "fields": "files(id,name,modifiedTime)",
        "spaces": "drive",
    })
    return _google_request(
        f"https://www.googleapis.com/drive/v3/files?{query}",
        str(payload.get("accessToken", "")),
    )


def google_create_sheet(payload: dict) -> dict:
    title = str(payload.get("title") or "RFFA Draft Results").strip()[:100]
    return _google_request(
        "https://sheets.googleapis.com/v4/spreadsheets",
        str(payload.get("accessToken", "")),
        method="POST",
        payload={"properties": {"title": title}},
    )


def google_sync_sheet(payload: dict) -> dict:
    token = str(payload.get("accessToken", ""))
    spreadsheet_id = _google_file_id(payload.get("spreadsheetId"))
    tab_title = str(payload.get("tabTitle", "")).strip()
    rows = payload.get("rows")
    if not tab_title or len(tab_title) > 100 or any(char in tab_title for char in "[]:*?/\\"):
        raise ValueError("Invalid Google Sheet tab name.")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 1000:
        raise ValueError("Invalid draft rows for Google sync.")
    if any(not isinstance(row, list) or len(row) > 20 for row in rows):
        raise ValueError("Invalid draft row format.")

    base = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}"
    metadata = _google_request(
        f"{base}?fields=sheets.properties",
        token,
    )
    exists = any(
        sheet.get("properties", {}).get("title") == tab_title
        for sheet in metadata.get("sheets", [])
    )
    if not exists:
        _google_request(
            f"{base}:batchUpdate",
            token,
            method="POST",
            payload={"requests": [{"addSheet": {"properties": {
                "title": tab_title,
                "gridProperties": {"frozenRowCount": 1},
            }}}]},
        )

    escaped_title = tab_title.replace("'", "''")
    write_a1 = f"'{escaped_title}'!A1:I{len(rows)}"
    write_range = urllib.parse.quote(write_a1, safe="")
    result = _google_request(
        f"{base}/values/{write_range}?valueInputOption=RAW",
        token,
        method="PUT",
        payload={"range": write_a1, "majorDimension": "ROWS", "values": rows},
    )
    # Clear only rows no longer present, and only after the current state is safely written.
    # This preserves the prior Sheet contents if Google rejects a write.
    if len(rows) < 1000:
        clear_a1 = f"'{escaped_title}'!A{len(rows) + 1}:I1000"
        clear_range = urllib.parse.quote(clear_a1, safe="")
        _google_request(f"{base}/values/{clear_range}:clear", token, method="POST", payload={})
    return {"ok": True, "updatedRows": result.get("updatedRows", len(rows))}


def _safe_year(value) -> int:
    year = int(value)
    if not 2020 <= year <= 2100:
        raise ValueError("Season must be between 2020 and 2100.")
    return year


def normalize_players(payload: dict, season: int) -> list[dict]:
    players = []
    seen = set()
    for entry in payload.get("players", []):
        player = entry.get("player") or entry
        player_id = player.get("id") or entry.get("id")
        position = POSITION_IDS.get(player.get("defaultPositionId"))
        name = player.get("fullName")
        if not player_id or not position or not name or player_id in seen:
            continue
        if player.get("active") is False:
            continue
        seen.add(player_id)
        ranks = player.get("draftRanksByRankType") or {}
        ppr = ranks.get("PPR") or ranks.get("STANDARD") or {}
        ownership = player.get("ownership") or entry.get("ownership") or {}
        rank = ppr.get("rank")
        if not isinstance(rank, (int, float)) or rank <= 0:
            rank = 9999
        adp = ownership.get("averageDraftPosition")
        if not isinstance(adp, (int, float)) or adp <= 0:
            adp = None
        players.append({
            "id": str(player_id),
            "name": name,
            "position": position,
            "proTeam": PRO_TEAMS.get(player.get("proTeamId"), "FA"),
            "rank": int(rank),
            "adp": round(adp, 1) if adp else None,
            "auction": ppr.get("auctionValue"),
            "injury": player.get("injuryStatus") or "ACTIVE",
            "season": season,
        })
    players.sort(key=lambda p: (p["rank"], p["adp"] or 9999, p["name"]))
    return players


def refresh_players(season: int) -> list[dict]:
    url = (
        "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/"
        f"seasons/{season}/segments/0/leaguedefaults/3?view=kona_player_info"
    )
    fantasy_filter = {
        "players": {
            "limit": 1500,
            "filterSlotIds": {"value": [0, 2, 4, 6, 16, 17]},
            "filterRanksForRankTypes": {"value": ["PPR"]},
            "sortDraftRanks": {"sortPriority": 1, "sortAsc": True, "value": "PPR"},
            "sortPercOwned": {"sortPriority": 2, "sortAsc": False},
        }
    }
    normalized = normalize_players(_espn_request(url, fantasy_filter=fantasy_filter), season)
    if len(normalized) < 250:
        raise RuntimeError(f"ESPN returned only {len(normalized)} draftable players.")
    DATA_DIR.mkdir(exist_ok=True)
    cache = {"season": season, "source": "ESPN", "players": normalized}
    (DATA_DIR / f"players-{season}.json").write_text(
        json.dumps(cache, separators=(",", ":")), encoding="utf-8"
    )
    return normalized


def load_players(season: int, force=False) -> tuple[list[dict], str]:
    cache_path = DATA_DIR / f"players-{season}.json"
    if cache_path.exists() and not force:
        data = json.loads(cache_path.read_text(encoding="utf-8"))
        return data.get("players", []), "cache"
    try:
        return refresh_players(season), "ESPN"
    except Exception:
        if cache_path.exists():
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            return data.get("players", []), "cache-fallback"
        raise


def load_league(payload: dict) -> dict:
    season = _safe_year(payload.get("season"))
    league_id = str(payload.get("leagueId", "")).strip()
    if not re.fullmatch(r"\d+", league_id):
        raise ValueError("ESPN league ID must contain only numbers.")
    url = (
        "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/"
        f"seasons/{season}/segments/0/leagues/{league_id}?view=mTeam&view=mSettings"
    )
    data = _espn_request(
        url,
        espn_s2=str(payload.get("espnS2", "")),
        swid=str(payload.get("swid", "")),
    )
    members = {str(m.get("id")): m for m in data.get("members", [])}
    teams = []
    for team in data.get("teams", []):
        owner = members.get(str(team.get("primaryOwner")), {})
        name = team.get("name") or " ".join(
            part for part in [team.get("location"), team.get("nickname")] if part
        )
        teams.append({
            "id": str(team.get("id")),
            "name": name or team.get("abbrev") or f"Team {team.get('id')}",
            "owner": owner.get("displayName") or owner.get("firstName") or "",
            "abbrev": team.get("abbrev") or "",
            "logo": team.get("logo") or "",
        })
    if not teams:
        raise RuntimeError("ESPN returned no teams. Check the season, league ID, and private-league cookies.")
    return {
        "leagueId": league_id,
        "season": season,
        "name": data.get("settings", {}).get("name") or data.get("name") or "ESPN League",
        "teams": teams,
    }


class DraftHandler(SimpleHTTPRequestHandler):
    server_version = "RFFADraft/1.0"

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def _json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, exc, status=HTTPStatus.BAD_REQUEST):
        if isinstance(exc, urllib.error.HTTPError):
            if exc.code in (401, 403):
                message = "ESPN rejected the request. For a private league, update espn_s2 and SWID."
            elif exc.code == 404:
                message = "ESPN could not find that league or season."
            else:
                message = f"ESPN returned HTTP {exc.code}."
            status = HTTPStatus.BAD_GATEWAY
        elif isinstance(exc, urllib.error.URLError):
            message = "Could not reach ESPN. Check the internet connection and try again."
            status = HTTPStatus.BAD_GATEWAY
        else:
            message = str(exc) or exc.__class__.__name__
        self._json({"error": message}, status)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            return self._json({"ok": True, "app": "RFFA Draft Room"})
        if parsed.path == "/api/players":
            try:
                params = urllib.parse.parse_qs(parsed.query)
                season = _safe_year(params.get("season", ["2026"])[0])
                force = params.get("refresh", ["0"])[0] == "1"
                players, source = load_players(season, force)
                return self._json({"players": players, "source": source, "count": len(players)})
            except Exception as exc:
                return self._error(exc, HTTPStatus.BAD_GATEWAY)
        if parsed.path.startswith("/api/"):
            return self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        if parsed.path not in ("/", "/index.html", "/app.js", "/styles.css"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.path = parsed.path
        return super().do_GET()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1_000_000:
                return self._json({"error": "Request too large"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json({"error": "Invalid JSON request"}, HTTPStatus.BAD_REQUEST)
        if self.path == "/api/espn/league":
            try:
                return self._json(load_league(payload))
            except Exception as exc:
                return self._error(exc)
        if self.path == "/api/google/files":
            try:
                return self._json(google_list_sheets(payload))
            except Exception as exc:
                return self._error(exc)
        if self.path == "/api/google/create":
            try:
                return self._json(google_create_sheet(payload))
            except Exception as exc:
                return self._error(exc)
        if self.path == "/api/google/sync":
            try:
                return self._json(google_sync_sheet(payload))
            except Exception as exc:
                return self._error(exc)
        return self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def translate_path(self, path):
        parsed = urllib.parse.urlparse(path)
        clean = os.path.normpath(urllib.parse.unquote(parsed.path)).lstrip("/\\")
        candidate = (ROOT / clean).resolve()
        try:
            candidate.relative_to(ROOT)
        except ValueError:
            return str(ROOT / "__not_found__")
        if candidate.is_dir():
            candidate = candidate / "index.html"
        return str(candidate)

    def guess_type(self, path):
        return mimetypes.guess_type(path)[0] or "application/octet-stream"


def main():
    port = int(os.environ.get("RFFA_PORT", DEFAULT_PORT))
    server = ThreadingHTTPServer((HOST, port), DraftHandler)
    url = f"http://localhost:{port}"
    print(f"RFFA Draft Room is running at {url}")
    print("Press Ctrl+C to stop it.")
    if "--no-browser" not in sys.argv:
        Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDraft room stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
