"use strict";

const STORAGE_KEY = "rffa-draft-state-v1";
const CLIENT_ID_KEY = "rffa-google-client-id";
const POSITIONS = ["ALL", "QB", "RB", "WR", "TE", "K", "D/ST"];
const STARTER_ROSTER_SLOTS = [
  { key: "QB", label: "QB", position: "QB" },
  { key: "RB1", label: "RB1", position: "RB" },
  { key: "RB2", label: "RB2", position: "RB" },
  { key: "WR1", label: "WR1", position: "WR" },
  { key: "WR2", label: "WR2", position: "WR" },
  { key: "TE", label: "TE", position: "TE" },
  { key: "FLEX", label: "FLEX", position: "FLEX" },
  { key: "K", label: "K", position: "K" },
  { key: "DST", label: "D/ST", position: "D/ST" },
];
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly";

const $ = (selector) => document.querySelector(selector);
const els = {
  setupView: $("#setupView"), draftView: $("#draftView"), season: $("#seasonInput"),
  leagueId: $("#leagueIdInput"), swid: $("#swidInput"), espnS2: $("#espnS2Input"),
  loadLeague: $("#loadLeagueBtn"), manualTeams: $("#manualTeamsBtn"), leagueMessage: $("#leagueMessage"),
  teamOrder: $("#teamOrderList"), teamOrderEmpty: $("#teamOrderEmpty"), rounds: $("#roundsInput"),
  playerBadge: $("#playerDataBadge"), clientId: $("#googleClientIdInput"), connectGoogle: $("#connectGoogleBtn"),
  createSheet: $("#createSheetBtn"), sheetSelect: $("#sheetSelect"), googleMessage: $("#googleMessage"),
  readiness: $("#readinessText"), startDraft: $("#startDraftBtn"), pickLabel: $("#pickLabel"),
  onClockTeam: $("#onClockTeam"), upcoming: $("#upcomingPicks"), syncStatus: $("#syncStatus"),
  displayMode: $("#displayModeBtn"), undo: $("#undoBtn"), export: $("#exportBtn"), exitDraft: $("#exitDraftBtn"),
  rosterViewButton: $("#rosterViewBtn"), rosterView: $("#rosterView"), rosterGrid: $("#rosterGrid"),
  rosterPickCount: $("#rosterPickCount"), closeRosterView: $("#closeRosterViewBtn"),
  search: $("#playerSearch"), positionFilters: $("#positionFilters"), availableCount: $("#availableCount"),
  playerTable: $("#playerTableBody"), draftBoard: $("#draftBoard"), draftBoardScroll: $("#draftBoardScroll"),
  boardPickCount: $("#boardPickCount"), boardCardPreview: $("#boardCardPreview"),
  boardSection: $(".draft-board-section"), toggleBoardFullscreen: $("#toggleBoardFullscreen"),
  confirmDialog: $("#confirmDialog"), confirmPlayer: $("#confirmPlayer"), confirmTeam: $("#confirmTeam"),
  confirmPick: $("#confirmPickBtn"), toasts: $("#toastRegion"),
};

const freshState = () => ({
  season: 2026, leagueId: "", leagueName: "", teams: [], rounds: 16,
  picks: [], mode: "setup", displayTheme: "outdoor", sheetId: "", sheetName: "", sheetTab: "", startedAt: "",
});

let state = loadState();
let players = [];
let filterPosition = "ALL";
let pendingPlayer = null;
let googleToken = "";
let googleTokenClient = null;
let syncQueue = Promise.resolve();
let draggedTeamId = null;
let boardFocusOverall = null;
let previewedBoardCard = null;
let boardFullscreenFallback = false;
let boardNameFitFrame = 0;

function loadState() {
  try {
    return { ...freshState(), ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch (_) {
    return freshState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}

function toast(message, kind = "") {
  const item = document.createElement("div");
  item.className = `toast ${kind}`;
  item.textContent = message;
  els.toasts.append(item);
  setTimeout(() => item.remove(), 4200);
}

function setMessage(element, message, kind = "") {
  element.textContent = message;
  element.className = `inline-message ${kind}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadPlayers(refresh = false) {
  const season = Number(els.season.value || state.season || 2026);
  els.playerBadge.textContent = refresh ? "Refreshing ESPN player pool…" : "Loading player pool…";
  els.playerBadge.className = "status-pill muted";
  try {
    const data = await api(`/api/players?season=${season}${refresh ? "&refresh=1" : ""}`);
    players = data.players;
    state.season = season;
    saveState();
    const counts = Object.fromEntries(POSITIONS.slice(1).map(pos => [pos, players.filter(p => p.position === pos).length]));
    els.playerBadge.textContent = `${data.count} players · ${counts.K} K · ${counts["D/ST"]} D/ST`;
    els.playerBadge.className = "status-pill";
    els.playerBadge.title = `Source: ${data.source}. Click to refresh from ESPN.`;
    updateReadiness();
    if (state.mode === "draft") renderDraft();
  } catch (error) {
    players = [];
    els.playerBadge.textContent = "Player data unavailable · click to retry";
    els.playerBadge.className = "status-pill error";
    els.playerBadge.title = error.message;
    updateReadiness();
  }
}

async function importLeague() {
  const leagueId = els.leagueId.value.trim();
  if (!leagueId) return setMessage(els.leagueMessage, "Enter the ESPN league ID.", "error");
  els.loadLeague.disabled = true;
  els.loadLeague.textContent = "Importing…";
  setMessage(els.leagueMessage, "Contacting ESPN…");
  try {
    const data = await api("/api/espn/league", {
      method: "POST",
      body: JSON.stringify({
        season: Number(els.season.value), leagueId,
        swid: els.swid.value.trim(), espnS2: els.espnS2.value.trim(),
      }),
    });
    state.season = data.season;
    state.leagueId = data.leagueId;
    state.leagueName = data.name;
    state.teams = data.teams;
    if (state.picks.length) state.picks = [];
    saveState();
    renderTeamOrder();
    updateReadiness();
    setMessage(els.leagueMessage, `${data.name}: imported ${data.teams.length} teams.`, data.teams.length === 12 ? "success" : "error");
    if (data.teams.length !== 12) toast(`This app is set for exactly 12 teams; ESPN returned ${data.teams.length}.`, "error");
  } catch (error) {
    setMessage(els.leagueMessage, error.message, "error");
  } finally {
    els.loadLeague.disabled = false;
    els.loadLeague.textContent = "Import ESPN teams";
    els.swid.value = "";
    els.espnS2.value = "";
  }
}

function createManualTeams() {
  state.teams = Array.from({ length: 12 }, (_, i) => ({
    id: `manual-${i + 1}`, name: `Team ${i + 1}`, owner: "", abbrev: `T${i + 1}`, logo: "",
  }));
  state.leagueName = "RFFA League";
  state.leagueId = "manual";
  state.picks = [];
  saveState();
  renderTeamOrder();
  updateReadiness();
  setMessage(els.leagueMessage, "Created 12 editable fallback teams.", "success");
}

function teamInitials(team) {
  return (team.abbrev || team.name.split(/\s+/).map(p => p[0]).join("")).slice(0, 3).toUpperCase();
}

function renderTeamOrder() {
  els.teamOrderEmpty.classList.toggle("hidden", state.teams.length > 0);
  els.teamOrder.innerHTML = state.teams.map((team, index) => `
    <li class="team-item" draggable="${state.picks.length ? "false" : "true"}" data-team-id="${escapeHtml(team.id)}">
      <span class="order-number">${String(index + 1).padStart(2, "0")}</span>
      ${team.logo ? `<img class="team-logo" src="${escapeHtml(team.logo)}" alt="">` : `<span class="team-initials">${escapeHtml(teamInitials(team))}</span>`}
      <span class="team-copy"><b contenteditable="${team.id.startsWith("manual-") ? "true" : "false"}" data-name-id="${escapeHtml(team.id)}">${escapeHtml(team.name)}</b><small>${escapeHtml(team.owner || team.abbrev || "Draft team")}</small></span>
      <span class="move-buttons"><button data-move="up" data-index="${index}" ${index === 0 || state.picks.length ? "disabled" : ""} aria-label="Move up">↑</button><button data-move="down" data-index="${index}" ${index === state.teams.length - 1 || state.picks.length ? "disabled" : ""} aria-label="Move down">↓</button></span>
    </li>`).join("");
}

function moveTeam(from, to) {
  if (state.picks.length || from === to || to < 0 || to >= state.teams.length) return;
  const [team] = state.teams.splice(from, 1);
  state.teams.splice(to, 0, team);
  saveState();
  renderTeamOrder();
}

function updateReadiness() {
  state.rounds = Math.max(1, Math.min(30, Number(els.rounds.value) || 16));
  const playersReady = players.length >= 250;
  const teamsReady = state.teams.length === 12;
  els.startDraft.disabled = !(playersReady && teamsReady);
  const notes = [];
  notes.push(playersReady ? `${players.length} players ready` : "player pool missing");
  notes.push(teamsReady ? "12 teams ordered" : `${state.teams.length}/12 teams loaded`);
  notes.push(state.sheetId ? `Google Sheet: ${state.sheetName}` : "Google Sheet not selected (local saves still work)");
  els.readiness.textContent = notes.join(" · ");
}

function pickContext(pickIndex = state.picks.length) {
  const teamCount = state.teams.length;
  if (!teamCount || pickIndex >= teamCount * state.rounds) return null;
  const roundIndex = Math.floor(pickIndex / teamCount);
  const slot = pickIndex % teamCount;
  const teamIndex = roundIndex % 2 ? teamCount - 1 - slot : slot;
  return { pickIndex, overall: pickIndex + 1, round: roundIndex + 1, slot: slot + 1, team: state.teams[teamIndex] };
}

function startDraft() {
  if (state.teams.length !== 12 || players.length < 250) return;
  state.rounds = Math.max(1, Math.min(30, Number(els.rounds.value) || 16));
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  if (!state.sheetTab) {
    const date = new Date();
    const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}-${String(date.getMinutes()).padStart(2, "0")}`;
    state.sheetTab = `RFFA Draft ${stamp}`;
  }
  state.mode = "draft";
  saveState();
  showMode();
  window.scrollTo({ top: 0, behavior: "instant" });
  renderDraft();
  if (googleToken && state.sheetId) queueSheetSync();
}

function showMode() {
  const drafting = state.mode === "draft";
  els.setupView.classList.toggle("hidden", drafting);
  els.draftView.classList.toggle("hidden", !drafting);
  document.title = drafting ? "RFFA · Live Draft" : "RFFA Draft Room";
  if (!drafting) closeRosterView(false);
  applyDisplayTheme();
}

function applyDisplayTheme() {
  const outdoor = state.displayTheme !== "dark";
  els.draftView.classList.toggle("outdoor-mode", outdoor);
  document.body.classList.toggle("outdoor-display", outdoor && state.mode === "draft");
  document.documentElement.dataset.displayTheme = outdoor ? "outdoor" : "dark";
  els.displayMode.innerHTML = outdoor ? "☾ <span>Dark display</span>" : "☀ <span>Outdoor display</span>";
  els.displayMode.title = outdoor ? "Switch to dark display" : "Switch to high-contrast outdoor display";
  els.displayMode.setAttribute("aria-label", els.displayMode.title);
  els.displayMode.setAttribute("aria-pressed", String(!outdoor));
}

function toggleDisplayTheme() {
  state.displayTheme = state.displayTheme === "dark" ? "outdoor" : "dark";
  saveState();
  applyDisplayTheme();
  toast(state.displayTheme === "dark" ? "Dark display enabled." : "High-contrast outdoor display enabled.");
}

function availablePlayers() {
  const drafted = new Set(state.picks.map(p => String(p.player.id)));
  return players.filter(p => !drafted.has(String(p.id)));
}

function injuryLabel(status) {
  if (!status || status === "ACTIVE" || status === "NORMAL") return "";
  return status.toLowerCase().replaceAll("_", " ");
}

function positionClass(position) {
  return `pos-${position.replace("/", "")}`;
}

function boardNameParts(player) {
  const fullName = String(player.name || "").trim();
  if (player.position === "D/ST") {
    return { last: fullName.replace(/\s+D\/ST$/i, "") || fullName, first: "D/ST" };
  }
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { last: fullName, first: "" };
  const suffixes = new Set(["JR.", "JR", "SR.", "SR", "II", "III", "IV", "V"]);
  const lastParts = [parts.pop()];
  if (suffixes.has(lastParts[0].toUpperCase()) && parts.length) lastParts.unshift(parts.pop());
  const prefixes = new Set(["ST.", "ST", "VAN", "VON", "DE", "DEL", "LA", "LE"]);
  if (parts.length > 1 && prefixes.has(parts[parts.length - 1].toUpperCase())) lastParts.unshift(parts.pop());
  return { last: lastParts.join(" "), first: parts.join(" ") };
}

function rosterSlotDefinitions() {
  const benchCount = Math.max(0, state.rounds - STARTER_ROSTER_SLOTS.length);
  return [
    ...STARTER_ROSTER_SLOTS,
    ...Array.from({ length: benchCount }, (_, index) => ({ key: `BN${index + 1}`, label: `BN${index + 1}`, position: "BN" })),
  ];
}

function assignTeamRoster(team) {
  const slots = rosterSlotDefinitions().map(slot => ({ ...slot, pick: null }));
  const picks = state.picks.filter(pick => String(pick.team.id) === String(team.id));
  const exactSlots = {
    QB: ["QB"], RB: ["RB1", "RB2"], WR: ["WR1", "WR2"], TE: ["TE"], K: ["K"], "D/ST": ["DST"],
  };
  picks.forEach(pick => {
    const position = pick.player.position;
    let slot = slots.find(item => exactSlots[position]?.includes(item.key) && !item.pick);
    if (!slot && ["RB", "WR", "TE"].includes(position)) slot = slots.find(item => item.key === "FLEX" && !item.pick);
    if (!slot) slot = slots.find(item => item.position === "BN" && !item.pick);
    if (slot) slot.pick = pick;
  });
  return slots;
}

function renderRosterView() {
  els.rosterPickCount.textContent = `(${state.picks.length}/${state.teams.length * state.rounds})`;
  els.rosterGrid.innerHTML = state.teams.map((team, teamIndex) => {
    const slots = assignTeamRoster(team);
    const filled = slots.filter(slot => slot.pick).length;
    return `<article class="roster-team-card">
      <header class="roster-team-header">
        <span>${String(teamIndex + 1).padStart(2, "0")}</span>
        <div><b>${escapeHtml(team.name)}</b><small>${filled}/${state.rounds} players</small></div>
      </header>
      <div class="roster-slots" style="--roster-slot-rows:${Math.ceil(slots.length / 2)}">
        ${slots.map(slot => {
          const player = slot.pick?.player;
          const posClass = player ? `roster-pos-${player.position.replace("/", "")}` : "";
          return `<div class="roster-slot ${player ? `filled ${posClass}` : "empty"}">
            <span class="roster-slot-label">${slot.label}</span>
            ${player ? `<b title="${escapeHtml(player.name)}">${escapeHtml(player.name)}</b><small>${escapeHtml(player.position)} · ${escapeHtml(player.proTeam)}</small>` : `<span class="roster-empty">—</span>`}
          </div>`;
        }).join("")}
      </div>
    </article>`;
  }).join("");
}

function resetBoardFullscreen() {
  boardFullscreenFallback = false;
  els.boardSection.classList.remove("board-maximized");
  document.body.classList.remove("board-maximized-open");
  updateBoardFullscreenButton();
  queueBoardNameFit();
}

async function openRosterView() {
  if (state.mode !== "draft" || !els.rosterView.classList.contains("hidden")) return;
  hideBoardCardPreview();
  if (document.fullscreenElement === els.boardSection) await document.exitFullscreen();
  if (boardFullscreenFallback) resetBoardFullscreen();
  renderRosterView();
  els.rosterView.classList.remove("hidden");
  document.body.classList.add("roster-view-open");
  els.closeRosterView.focus();
}

function closeRosterView(returnFocus = true) {
  if (!els.rosterView || els.rosterView.classList.contains("hidden")) return;
  els.rosterView.classList.add("hidden");
  document.body.classList.remove("roster-view-open");
  if (returnFocus) els.rosterViewButton.focus();
}

function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
}

function renderDraft() {
  if (!players.length) return;
  const context = pickContext();
  if (context) {
    els.pickLabel.textContent = `Pick ${context.round}.${String(context.slot).padStart(2, "0")} · ${context.overall} overall`;
    els.onClockTeam.textContent = `${context.team.name} is on the clock`;
  } else {
    els.pickLabel.textContent = `${state.picks.length} picks complete`;
    els.onClockTeam.textContent = "The draft is complete";
  }
  els.undo.disabled = !state.picks.length;
  renderUpcoming();
  renderPositionFilters();
  renderPlayerList();
  renderDraftBoard();
}

function renderUpcoming() {
  const cards = [];
  for (let i = state.picks.length; i < Math.min(state.picks.length + 7, state.teams.length * state.rounds); i++) {
    const context = pickContext(i);
    cards.push(`<div class="upcoming-card ${i === state.picks.length ? "current" : ""}"><small>${context.round}.${String(context.slot).padStart(2, "0")} · #${context.overall}</small><b>${escapeHtml(context.team.name)}</b></div>`);
  }
  els.upcoming.innerHTML = cards.join("") || '<div class="upcoming-card current"><b>Draft complete</b></div>';
}

function renderPositionFilters() {
  els.positionFilters.innerHTML = POSITIONS.map(pos => `<button class="filter-button ${filterPosition === pos ? "active" : ""}" data-position="${pos}">${pos}</button>`).join("");
}

function renderPlayerList() {
  const query = els.search.value.trim().toLowerCase();
  const available = availablePlayers();
  const filtered = available.filter(p => (filterPosition === "ALL" || p.position === filterPosition) && (!query || `${p.name} ${p.proTeam} ${p.position}`.toLowerCase().includes(query)));
  els.availableCount.textContent = `(${filtered.length})`;
  els.playerTable.innerHTML = filtered.map(player => `
    <tr>
      <td class="rank-cell">${player.rank < 9999 ? player.rank : "—"}</td>
      <td class="player-name"><b>${escapeHtml(player.name)}</b><small>${escapeHtml(player.proTeam)} · ADP ${player.adp ?? "—"}${injuryLabel(player.injury) ? ` · ${escapeHtml(injuryLabel(player.injury))}` : ""}</small></td>
      <td><span class="position-chip ${positionClass(player.position)}">${player.position}</span></td>
      <td><button class="draft-player-btn" data-player-id="${escapeHtml(player.id)}" ${pickContext() ? "" : "disabled"}>Draft</button></td>
    </tr>`).join("");
}

function fitNameElements(container, selector, minimumSize) {
  const names = [...container.querySelectorAll(selector)];
  names.forEach(name => { name.style.fontSize = ""; });
  names.forEach(name => {
    const availableWidth = name.clientWidth;
    const requiredWidth = name.scrollWidth;
    if (!availableWidth || requiredWidth <= availableWidth) return;
    const defaultSize = Number.parseFloat(getComputedStyle(name).fontSize);
    let fittedSize = Math.max(minimumSize, Math.floor((defaultSize * availableWidth / requiredWidth) * 9.6) / 10);
    name.style.fontSize = `${fittedSize}px`;
    while (name.scrollWidth > name.clientWidth && fittedSize > minimumSize) {
      fittedSize = Math.max(minimumSize, Math.round((fittedSize - 0.2) * 10) / 10);
      name.style.fontSize = `${fittedSize}px`;
    }
  });
}

function fitBoardNameFonts() {
  if (!els.draftBoard) return;
  const maximized = document.fullscreenElement === els.boardSection || boardFullscreenFallback;
  fitNameElements(els.draftBoard, ".board-last-name", maximized ? 10 : 7);
  fitNameElements(els.draftBoard, ".board-first-name", maximized ? 11 : 8);
}

function queueBoardNameFit() {
  cancelAnimationFrame(boardNameFitFrame);
  boardNameFitFrame = requestAnimationFrame(() => {
    boardNameFitFrame = 0;
    fitBoardNameFonts();
  });
}

function renderDraftBoard() {
  const context = pickContext();
  const teamCount = state.teams.length;
  els.boardPickCount.textContent = `(${state.picks.length}/${teamCount * state.rounds})`;
  els.draftBoard.style.gridTemplateColumns = `38px repeat(${teamCount}, minmax(0, 1fr))`;
  const cells = ['<div class="board-corner">RD</div>'];
  state.teams.forEach((team, index) => {
    cells.push(`<div class="board-team-header" title="${escapeHtml(team.name)}"><span>${String(index + 1).padStart(2, "0")}</span><b>${escapeHtml(team.abbrev || teamInitials(team))}</b><small>${escapeHtml(team.name)}</small></div>`);
  });
  for (let round = 1; round <= state.rounds; round++) {
    cells.push(`<div class="board-round-label"><span>${String(round).padStart(2, "0")}</span></div>`);
    state.teams.forEach((team, teamIndex) => {
      const overall = (round - 1) * teamCount + (round % 2 ? teamIndex + 1 : teamCount - teamIndex);
      const pick = state.picks.find(item => item.round === round && item.team.id === team.id);
      const isCurrent = context?.overall === overall;
      if (pick) {
        const posClass = pick.player.position.replace("/", "");
        const name = boardNameParts(pick.player);
        const isFocus = boardFocusOverall === overall;
        cells.push(`<div class="draft-board-cell filled draft-pos-${posClass}" tabindex="0" ${isFocus ? 'data-focus-pick="true"' : ""} title="#${overall} · ${escapeHtml(team.name)} · ${escapeHtml(pick.player.name)}">
          <span class="board-pick-number">#${overall}</span><b class="board-last-name">${escapeHtml(name.last.toUpperCase())}</b><span class="board-first-name">${escapeHtml(name.first.toUpperCase())}</span><small class="board-pick-meta">${escapeHtml(pick.player.position)} · ${escapeHtml(pick.player.proTeam)}</small>
        </div>`);
      } else {
        cells.push(`<div class="draft-board-cell ${isCurrent ? "current" : ""}" ${isCurrent ? 'data-current-pick="true"' : ""}><span class="board-pick-number">#${overall}</span>${isCurrent ? "<b>On the clock</b>" : ""}</div>`);
      }
    });
  }
  els.draftBoard.innerHTML = cells.join("");
  requestAnimationFrame(() => {
    fitBoardNameFonts();
    const target = els.draftBoard.querySelector('[data-focus-pick="true"]') || els.draftBoard.querySelector('[data-current-pick="true"]');
    if (!target || !els.draftBoardScroll) return;
    const targetTop = target.offsetTop - els.draftBoard.offsetTop;
    const top = Math.max(0, targetTop - (els.draftBoardScroll.clientHeight - target.offsetHeight) / 2);
    els.draftBoardScroll.scrollTo({ top, behavior: "smooth" });
    boardFocusOverall = null;
  });
}

function showBoardCardPreview(card) {
  if (!card || !els.boardCardPreview) return;
  previewedBoardCard = card;
  const positionClassName = [...card.classList].find(name => name.startsWith("draft-pos-")) || "";
  const rect = card.getBoundingClientRect();
  const width = Math.min(250, Math.max(190, rect.width * 2.8));
  const height = Math.min(180, Math.max(145, rect.height * 2.15));
  const margin = 12;
  const left = Math.min(window.innerWidth - width - margin, Math.max(margin, rect.left + rect.width / 2 - width / 2));
  const top = Math.min(window.innerHeight - height - margin, Math.max(margin, rect.top + rect.height / 2 - height / 2));
  els.boardCardPreview.className = `board-card-preview ${positionClassName}`;
  els.boardCardPreview.innerHTML = card.innerHTML;
  els.boardCardPreview.style.width = `${width}px`;
  els.boardCardPreview.style.height = `${height}px`;
  els.boardCardPreview.style.left = `${left}px`;
  els.boardCardPreview.style.top = `${top}px`;
  fitNameElements(els.boardCardPreview, ".board-last-name", 16);
  fitNameElements(els.boardCardPreview, ".board-first-name", 13);
  els.boardCardPreview.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => els.boardCardPreview.classList.add("visible"));
}

function hideBoardCardPreview() {
  previewedBoardCard = null;
  if (!els.boardCardPreview) return;
  els.boardCardPreview.classList.remove("visible");
  els.boardCardPreview.setAttribute("aria-hidden", "true");
}

function updateBoardFullscreenButton() {
  const active = document.fullscreenElement === els.boardSection || boardFullscreenFallback;
  els.toggleBoardFullscreen.innerHTML = active ? "<span>✕</span> Exit full screen" : "<span>⛶</span> Full screen";
  els.toggleBoardFullscreen.setAttribute("aria-label", active ? "Exit full-screen draft board" : "Show draft board full screen");
}

async function toggleBoardFullscreen() {
  hideBoardCardPreview();
  if (document.fullscreenElement === els.boardSection) {
    await document.exitFullscreen();
    return;
  }
  if (boardFullscreenFallback) {
    boardFullscreenFallback = false;
    els.boardSection.classList.remove("board-maximized");
    document.body.classList.remove("board-maximized-open");
    updateBoardFullscreenButton();
    queueBoardNameFit();
    return;
  }
  try {
    if (!els.boardSection.requestFullscreen) throw new Error("Fullscreen API unavailable");
    await els.boardSection.requestFullscreen();
  } catch (_) {
    boardFullscreenFallback = true;
    els.boardSection.classList.add("board-maximized");
    document.body.classList.add("board-maximized-open");
    updateBoardFullscreenButton();
    queueBoardNameFit();
  }
}

function openPickDialog(playerId) {
  const context = pickContext();
  const player = players.find(p => String(p.id) === String(playerId));
  if (!context || !player || state.picks.some(p => String(p.player.id) === String(player.id))) return;
  pendingPlayer = player;
  els.confirmPlayer.innerHTML = `${escapeHtml(player.name)}<small>${escapeHtml(player.position)} · ${escapeHtml(player.proTeam)} · PPR rank ${player.rank < 9999 ? player.rank : "—"}</small>`;
  els.confirmTeam.textContent = `${context.team.name} · Pick ${context.round}.${String(context.slot).padStart(2, "0")}`;
  els.confirmDialog.showModal();
}

function makePick() {
  const context = pickContext();
  if (!context || !pendingPlayer) return;
  if (state.picks.some(p => String(p.player.id) === String(pendingPlayer.id))) return toast("That player was already drafted.", "error");
  state.picks.push({
    overall: context.overall, round: context.round, slot: context.slot,
    team: { id: context.team.id, name: context.team.name },
    player: { ...pendingPlayer }, pickedAt: new Date().toISOString(),
  });
  boardFocusOverall = context.overall;
  pendingPlayer = null;
  saveState();
  renderDraft();
  queueSheetSync();
}

function undoPick() {
  if (!state.picks.length) return;
  const removed = state.picks.pop();
  saveState();
  renderDraft();
  queueSheetSync();
  toast(`Undid ${removed.player.name} to ${removed.team.name}.`);
}

function exportCsv() {
  const rows = [["Overall", "Round", "Pick", "Fantasy Team", "Player", "Position", "NFL Team", "PPR Rank", "Picked At"]];
  state.picks.forEach(p => rows.push([p.overall, p.round, p.slot, p.team.name, p.player.name, p.player.position, p.player.proTeam, p.player.rank < 9999 ? p.player.rank : "", p.pickedAt]));
  const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const blob = new Blob([rows.map(row => row.map(quote).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `rffa-draft-${state.season}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function exitToSetup() {
  state.mode = "setup";
  saveState();
  showMode();
  window.scrollTo({ top: 0, behavior: "instant" });
  renderTeamOrder();
  updateReadiness();
}

function googleReady() {
  return window.google?.accounts?.oauth2;
}

function connectGoogle() {
  const clientId = els.clientId.value.trim();
  if (!clientId.endsWith(".apps.googleusercontent.com")) return setMessage(els.googleMessage, "Enter a valid Google Web OAuth Client ID.", "error");
  if (!googleReady()) return setMessage(els.googleMessage, "Google sign-in is still loading. Try again in a moment.", "error");
  localStorage.setItem(CLIENT_ID_KEY, clientId);
  els.connectGoogle.disabled = true;
  googleTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GOOGLE_SCOPES,
    callback: async response => {
      els.connectGoogle.disabled = false;
      if (response.error) return setMessage(els.googleMessage, response.error_description || response.error, "error");
      googleToken = response.access_token;
      els.connectGoogle.textContent = "Reconnect Google";
      els.createSheet.disabled = false;
      setMessage(els.googleMessage, "Connected. Loading your spreadsheets…", "success");
      try {
        await listSheets();
        if (state.sheetId && state.mode === "draft") queueSheetSync();
      } catch (error) {
        setMessage(els.googleMessage, error.message, "error");
      }
    },
  });
  googleTokenClient.requestAccessToken({ prompt: googleToken ? "" : "consent" });
}

async function listSheets() {
  const data = await api("/api/google/files", {
    method: "POST",
    body: JSON.stringify({ accessToken: googleToken }),
  });
  els.sheetSelect.innerHTML = '<option value="">Choose a spreadsheet…</option>' + data.files.map(file => `<option value="${escapeHtml(file.id)}" ${file.id === state.sheetId ? "selected" : ""}>${escapeHtml(file.name)}</option>`).join("");
  els.sheetSelect.disabled = false;
  setMessage(els.googleMessage, `Connected · ${data.files.length} recent spreadsheets found.`, "success");
  updateReadiness();
}

async function createGoogleSheet() {
  els.createSheet.disabled = true;
  try {
    const created = await api("/api/google/create", {
      method: "POST",
      body: JSON.stringify({ accessToken: googleToken, title: `RFFA ${state.season} Draft Results` }),
    });
    state.sheetId = created.spreadsheetId;
    state.sheetName = created.properties.title;
    saveState();
    await listSheets();
    els.sheetSelect.value = state.sheetId;
    setMessage(els.googleMessage, `Created and selected “${state.sheetName}”.`, "success");
    updateReadiness();
  } catch (error) {
    setMessage(els.googleMessage, error.message, "error");
  } finally {
    els.createSheet.disabled = false;
  }
}

function sheetRows() {
  const rows = [["Overall", "Round", "Pick", "Fantasy Team", "Player", "Position", "NFL Team", "PPR Rank", "Picked At"]];
  state.picks.forEach(p => rows.push([p.overall, p.round, p.slot, p.team.name, p.player.name, p.player.position, p.player.proTeam, p.player.rank < 9999 ? p.player.rank : "", p.pickedAt]));
  return rows;
}

async function syncSheet() {
  if (!googleToken || !state.sheetId || !state.sheetTab) {
    els.syncStatus.textContent = state.sheetId ? "Google reconnect needed" : "Saved locally";
    els.syncStatus.className = `sync-status ${state.sheetId ? "error" : "local"}`;
    return;
  }
  els.syncStatus.textContent = "Syncing…";
  els.syncStatus.className = "sync-status";
  try {
    await api("/api/google/sync", {
      method: "POST",
      body: JSON.stringify({
        accessToken: googleToken,
        spreadsheetId: state.sheetId,
        tabTitle: state.sheetTab,
        rows: sheetRows(),
      }),
    });
    els.syncStatus.textContent = `Synced · ${state.sheetName}`;
    els.syncStatus.className = "sync-status";
  } catch (error) {
    els.syncStatus.textContent = "Google sync paused";
    els.syncStatus.className = "sync-status error";
    toast(`${error.message} Picks remain saved locally.`, "error");
  }
}

function queueSheetSync() {
  syncQueue = syncQueue.then(syncSheet, syncSheet);
}

function bindEvents() {
  els.playerBadge.addEventListener("click", () => loadPlayers(true));
  els.loadLeague.addEventListener("click", importLeague);
  els.manualTeams.addEventListener("click", createManualTeams);
  els.rounds.addEventListener("input", () => { state.rounds = Number(els.rounds.value); saveState(); updateReadiness(); });
  els.season.addEventListener("change", () => loadPlayers(false));
  els.startDraft.addEventListener("click", startDraft);
  els.connectGoogle.addEventListener("click", connectGoogle);
  els.createSheet.addEventListener("click", createGoogleSheet);
  els.sheetSelect.addEventListener("change", () => {
    const option = els.sheetSelect.selectedOptions[0];
    state.sheetId = option?.value || "";
    state.sheetName = option?.textContent || "";
    if (!state.picks.length) state.sheetTab = "";
    saveState(); updateReadiness();
    if (state.sheetId) setMessage(els.googleMessage, `Selected “${state.sheetName}”.`, "success");
  });
  els.teamOrder.addEventListener("click", event => {
    const button = event.target.closest("button[data-move]");
    if (!button) return;
    const from = Number(button.dataset.index);
    moveTeam(from, from + (button.dataset.move === "up" ? -1 : 1));
  });
  els.teamOrder.addEventListener("input", event => {
    const name = event.target.closest("[data-name-id]");
    if (!name) return;
    const team = state.teams.find(t => t.id === name.dataset.nameId);
    if (team) { team.name = name.textContent.trim() || team.name; saveState(); }
  });
  els.teamOrder.addEventListener("dragstart", event => { draggedTeamId = event.target.closest("[data-team-id]")?.dataset.teamId; event.target.closest("[data-team-id]")?.classList.add("dragging"); });
  els.teamOrder.addEventListener("dragend", event => { event.target.closest("[data-team-id]")?.classList.remove("dragging"); draggedTeamId = null; });
  els.teamOrder.addEventListener("dragover", event => event.preventDefault());
  els.teamOrder.addEventListener("drop", event => {
    event.preventDefault();
    const targetId = event.target.closest("[data-team-id]")?.dataset.teamId;
    const from = state.teams.findIndex(t => t.id === draggedTeamId);
    const to = state.teams.findIndex(t => t.id === targetId);
    moveTeam(from, to);
  });
  els.positionFilters.addEventListener("click", event => {
    const button = event.target.closest("[data-position]");
    if (!button) return;
    filterPosition = button.dataset.position;
    renderPositionFilters(); renderPlayerList();
  });
  els.search.addEventListener("input", renderPlayerList);
  els.playerTable.addEventListener("click", event => {
    const button = event.target.closest("[data-player-id]");
    if (button) openPickDialog(button.dataset.playerId);
  });
  els.draftBoard.addEventListener("mouseover", event => {
    const card = event.target.closest(".draft-board-cell.filled");
    if (card && card !== previewedBoardCard) showBoardCardPreview(card);
  });
  els.draftBoard.addEventListener("mouseout", event => {
    const card = event.target.closest(".draft-board-cell.filled");
    if (card && !card.contains(event.relatedTarget)) hideBoardCardPreview();
  });
  els.draftBoard.addEventListener("focusin", event => {
    const card = event.target.closest(".draft-board-cell.filled");
    if (card) showBoardCardPreview(card);
  });
  els.draftBoard.addEventListener("focusout", hideBoardCardPreview);
  els.draftBoardScroll.addEventListener("scroll", hideBoardCardPreview, { passive: true });
  window.addEventListener("resize", () => {
    hideBoardCardPreview();
    queueBoardNameFit();
  });
  els.toggleBoardFullscreen.addEventListener("click", toggleBoardFullscreen);
  els.rosterViewButton.addEventListener("click", openRosterView);
  els.closeRosterView.addEventListener("click", () => closeRosterView());
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement !== els.boardSection) boardFullscreenFallback = false;
    updateBoardFullscreenButton();
    queueBoardNameFit();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !els.rosterView.classList.contains("hidden")) {
      event.preventDefault();
      closeRosterView();
      return;
    }
    if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "r" && !isTypingTarget(event.target) && !els.confirmDialog.open) {
      event.preventDefault();
      if (els.rosterView.classList.contains("hidden")) openRosterView(); else closeRosterView();
      return;
    }
    if (event.key === "Escape" && boardFullscreenFallback) {
      boardFullscreenFallback = false;
      els.boardSection.classList.remove("board-maximized");
      document.body.classList.remove("board-maximized-open");
      updateBoardFullscreenButton();
      queueBoardNameFit();
    }
  });
  els.confirmPick.addEventListener("click", makePick);
  els.undo.addEventListener("click", undoPick);
  els.displayMode.addEventListener("click", toggleDisplayTheme);
  els.export.addEventListener("click", exportCsv);
  els.exitDraft.addEventListener("click", exitToSetup);
}

function init() {
  els.season.value = state.season;
  els.leagueId.value = state.leagueId === "manual" ? "" : state.leagueId;
  els.rounds.value = state.rounds;
  els.clientId.value = localStorage.getItem(CLIENT_ID_KEY) || "";
  renderTeamOrder();
  bindEvents();
  showMode();
  updateReadiness();
  loadPlayers(false);
}

init();
