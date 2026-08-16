import json
import tempfile
import unittest
from unittest import mock

import server


class PlayerNormalizationTests(unittest.TestCase):
    def test_normalizes_ppr_player_and_ignores_irrelevant_positions(self):
        payload = {
            "players": [
                {"player": {
                    "id": 101, "fullName": "Test Runner", "defaultPositionId": 2,
                    "proTeamId": 8, "active": True, "injuryStatus": "ACTIVE",
                    "draftRanksByRankType": {"PPR": {"rank": 7, "auctionValue": 45}},
                    "ownership": {"averageDraftPosition": 8.37},
                }},
                {"player": {"id": 102, "fullName": "Punter", "defaultPositionId": 9, "active": True}},
            ]
        }
        result = server.normalize_players(payload, 2026)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["position"], "RB")
        self.assertEqual(result[0]["proTeam"], "DET")
        self.assertEqual(result[0]["rank"], 7)
        self.assertEqual(result[0]["adp"], 8.4)

    def test_includes_kickers_and_defenses(self):
        payload = {"players": [
            {"player": {"id": 1, "fullName": "A Kicker", "defaultPositionId": 5, "active": True}},
            {"player": {"id": 2, "fullName": "A Defense D/ST", "defaultPositionId": 16, "active": True}},
        ]}
        result = server.normalize_players(payload, 2026)
        self.assertEqual({p["position"] for p in result}, {"K", "D/ST"})

    def test_inactive_players_are_ignored(self):
        payload = {"players": [
            {"player": {"id": 1, "fullName": "Retired Player", "defaultPositionId": 1, "active": False}},
        ]}
        self.assertEqual(server.normalize_players(payload, 2026), [])


class LeagueNormalizationTests(unittest.TestCase):
    @mock.patch("server._espn_request")
    def test_maps_espn_teams_and_owner(self, request):
        request.return_value = {
            "settings": {"name": "Test League"},
            "members": [{"id": "owner-1", "displayName": "Jamie"}],
            "teams": [{
                "id": 3, "location": "Sunday", "nickname": "Scaries", "abbrev": "SUN",
                "primaryOwner": "owner-1", "logo": "https://example.com/logo.png",
            }],
        }
        result = server.load_league({"season": 2026, "leagueId": "123", "swid": "abc", "espnS2": "secret"})
        self.assertEqual(result["name"], "Test League")
        self.assertEqual(result["teams"][0]["name"], "Sunday Scaries")
        self.assertEqual(result["teams"][0]["owner"], "Jamie")
        _, kwargs = request.call_args
        self.assertEqual(kwargs["swid"], "abc")
        self.assertEqual(kwargs["espn_s2"], "secret")

    def test_rejects_non_numeric_league_id(self):
        with self.assertRaisesRegex(ValueError, "only numbers"):
            server.load_league({"season": 2026, "leagueId": "abc"})


class CacheTests(unittest.TestCase):
    def test_loads_existing_cache_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_dir = server.Path(directory)
            cache_dir.joinpath("players-2026.json").write_text(
                json.dumps({"players": [{"id": "1", "name": "Cached"}]}), encoding="utf-8"
            )
            with mock.patch.object(server, "DATA_DIR", cache_dir), mock.patch("server.refresh_players") as refresh:
                players, source = server.load_players(2026)
            self.assertEqual(players[0]["name"], "Cached")
            self.assertEqual(source, "cache")
            refresh.assert_not_called()


class GoogleSyncTests(unittest.TestCase):
    @mock.patch("server._google_request")
    def test_sync_creates_tab_clears_and_writes_rows(self, request):
        request.side_effect = [
            {"sheets": [{"properties": {"title": "Sheet1"}}]},
            {},
            {"updatedRows": 2},
            {},
        ]
        result = server.google_sync_sheet({
            "accessToken": "test-token",
            "spreadsheetId": "spreadsheet_12345",
            "tabTitle": "RFFA Draft 2026-08-13",
            "rows": [["Overall", "Player"], [1, "Test Player"]],
        })
        self.assertEqual(result, {"ok": True, "updatedRows": 2})
        self.assertEqual(request.call_count, 4)
        self.assertTrue(request.call_args_list[1].args[0].endswith(":batchUpdate"))
        self.assertEqual(request.call_args_list[2].kwargs["method"], "PUT")
        self.assertEqual(
            request.call_args_list[2].kwargs["payload"]["range"],
            "'RFFA Draft 2026-08-13'!A1:I2",
        )
        self.assertIn(":clear", request.call_args_list[3].args[0])
        self.assertIn("A3%3AI1000", request.call_args_list[3].args[0])

    @mock.patch("server._google_request")
    def test_sync_reuses_existing_tab(self, request):
        request.side_effect = [
            {"sheets": [{"properties": {"title": "Live Draft"}}]},
            {"updatedRows": 1},
            {},
        ]
        server.google_sync_sheet({
            "accessToken": "test-token",
            "spreadsheetId": "spreadsheet_12345",
            "tabTitle": "Live Draft",
            "rows": [["Overall"]],
        })
        self.assertEqual(request.call_count, 3)
        self.assertNotIn(":batchUpdate", " ".join(call.args[0] for call in request.call_args_list))

    def test_sync_rejects_invalid_spreadsheet_id(self):
        with self.assertRaisesRegex(ValueError, "spreadsheet ID"):
            server.google_sync_sheet({
                "accessToken": "test-token", "spreadsheetId": "bad!", "tabTitle": "Draft", "rows": [[1]],
            })


if __name__ == "__main__":
    unittest.main()
