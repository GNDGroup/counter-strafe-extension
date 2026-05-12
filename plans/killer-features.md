# Killer features — make CounterStrafe extension beat the "counterpicker" crowd

Goal: ship features competitors physically can't (we have an ML engine, demo
parser, render server, LLM, grenade content). User said "делай все" with one
constraint: **don't download opponents' past demos** → skip the two demo-heavy
ones (instant demo analysis, opponent profiling).

## Status legend
- [ ] not started · [~] in progress · [x] done · [skip] out of scope

## Extension-only (no backend deploy needed)

- [x] **#1 AI win-probability per map** — `win_prob` is already in the prematch
  API (`{de_mirage: 0.37, ...}` = P(faction1 wins)). Show it in the panel's map
  column as the primary number; keep stat-advantage as the dim secondary line.
- [x] **#2 Lite impact score** — composite from KD·WR·KR·HS·ELO (no demos).
  Show a 0–100 "Impact" pill in the inline strip + panel player rows. Highlight
  mismatch: high KD + low impact = stat-padder marker.
- [x] **#6 Smurf / booster flag** — heuristic: low total matches (<150) + high
  ELO (>1800) + high HS% (>50) + level ≥8 → 🚩. Tooltip explains why.
- [x] **#5 Grenade lineups for the picked map** — once `data.map` is known
  (veto resolved / finished), show a link/button in the panel + strip to
  `counterstrafe.pro/map/<map>` (grenade playlists). No demos needed — our own
  content.
- [x] **#10 One-click share card** — button in the panel header → render a
  canvas image (both teams, impact ratings, map recs, win-probs) and either
  copy to clipboard as PNG or open `counterstrafe.pro/match/<id>/share`.

## Backend changes (counter-strafe-backend repo — careful, prod CI)

- [ ] **Cloudflare 403 fix** (prerequisite for recent stats / party / streak /
  duo synergy) — `api.faceit.com/stats/v1/` is blocked. Try: realistic
  User-Agent + browser headers in `doRequestInternal`; if still blocked, route
  the internal stats call through the playwright-downloader service.
- [ ] **#7 Duo / party synergy** — `detectParties` already groups players by
  shared recent match IDs. Add: keep per-match W/L in `RecentStats`, then for
  each detected party compute "N matches together, X% WR" and surface as
  `party_synergy` in the response. Depends on the CF fix.
- [x] **#8 Live veto AI coach with reasoning** — mostly extension: build a
  short reasoning string from `win_prob` + team map scores + standout players
  ("ban Nuke — 42% for you, kagek1 1.6 KD there"). Backend may add a tidy
  `veto_advice` field later; start client-side.
- [x] **#9 Personal prep sheet** — for the logged-in player: weak maps vs their
  strong maps, opponent IGL guess, key threats. Needs `playerID` (already in
  background CHECK_AUTH) + cross-referencing. Extension-side first, backend
  endpoint later if it gets heavy.

## Skipped (need opponent demo downloads)
- [skip] #3 Instant post-match demo analysis
- [skip] #4 Opponent playstyle profiling from demos

## Sequencing
1. #1 win-prob (trivial, high wow) → 2. #2 impact → 3. #6 smurf → 4. #5 nades
   → 5. #8 veto reasoning (client) → 6. #9 prep sheet (client) → 7. #10 share
   → 8. CF fix (backend) → 9. #7 synergy (backend, after CF)
