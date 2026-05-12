// CounterStrafe Analytics — Content Script
// Injects an analytics panel into FACEIT match room pages.

(function () {
  'use strict'

  // ── Constants ──────────────────────────────────────────────────────────────
  const PANEL_ID = 'cs-analytics-panel'
  const STORAGE_KEY = 'cs_panel_collapsed'

  // FACEIT match room URL regex: /room/<matchID>, /match/<matchID>, or cs2/cs:go variants
  const ROOM_RE = /\/(?:room|match)\/(1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

  // ── State ─────────────────────────────────────────────────────────────────
  let currentMatchID = null
  let panelCollapsed = false
  let panelEnabled = true
  let inlineEnabled = true

  // Load collapsed preference
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) panelCollapsed = stored === '1'
  } catch { /* noop */ }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function extractMatchID(url) {
    const m = url.match(ROOM_RE)
    return m ? m[1] : null
  }

  function saveCollapsed(v) {
    panelCollapsed = v
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0') } catch { /* noop */ }
  }

  function skillColor(level) {
    const colors = ['', '#eee', '#1ce400', '#1ce400', '#1ce400', '#1ce400', '#f5a623', '#f5a623', '#ff6b6b', '#ff6b6b', '#aa00ff']
    return colors[Math.min(level, 10)] || '#888'
  }

  function fmtKD(kd) {
    const n = parseFloat(kd)
    if (isNaN(n)) return kd
    return n.toFixed(2)
  }

  function fmtWR(wr) {
    const n = parseFloat(wr)
    if (isNaN(n)) return wr
    return n.toFixed(0) + '%'
  }

  // ── Map veto logic ────────────────────────────────────────────────────────

  const CS2_MAP_POOL = ['de_mirage', 'de_dust2', 'de_inferno', 'de_anubis', 'de_nuke', 'de_ancient', 'de_overpass']

  // Skill level → contribution weight. Level 10 = 4× stronger signal than level 1.
  const SKILL_WEIGHTS = [0, 0.50, 0.62, 0.74, 0.85, 0.94, 1.00, 1.18, 1.40, 1.68, 2.00]

  function normMap(m) {
    return (m || '').replace(/^de_/i, '').toLowerCase()
  }

  /**
   * Score a single player on one map (0–100 scale, 50 = neutral).
   * Uses WR (50%), KD (30%), KR (20%), shrunk toward 50 by experience confidence.
   * Returns null when the player has no data on this map.
   */
  function playerMapScore(ms) {
    const wr  = parseFloat(ms.win_rate)  || 0
    const kd  = parseFloat(ms.kd_ratio)  || 0
    const kr  = parseFloat(ms.kr_ratio)  || 0
    const g   = parseInt(ms.matches)     || 0
    if (!wr && !kd) return null

    // Normalise into 0–100:
    //   KD: 0.5→0, 1.0→33, 1.5→67, 2.0→100
    //   KR: 0.15→0, 0.35→40, 0.65→100  (falls back to KD-derived if absent)
    const kdN = Math.min(Math.max((kd - 0.5) / 1.5, 0), 1) * 100
    const krN = kr > 0 ? Math.min(Math.max((kr - 0.15) / 0.5, 0), 1) * 100 : kdN

    // Bayesian shrinkage: conf = games / (games + prior)
    // prior=12 означает что нужно ~12 игр чтобы на 50% доверять данным
    // 1 игра → conf≈0.08 (почти всё нейтрально)
    // 10 игр → conf≈0.45
    // 30 игр → conf≈0.71
    // 60 игр → conf≈0.83
    const PRIOR = 12
    const conf = g / (g + PRIOR)

    const raw = wr * 0.50 + kdN * 0.30 + krN * 0.20
    return raw * conf + 50 * (1 - conf)
  }

  /**
   * Aggregate team score on a map.
   * Weights each player's contribution by skill level.
   * Returns { score: 0–100, coverage: 0–1 }
   */
  function teamMapScore(players, mapName) {
    const nm = normMap(mapName)
    let wScore = 0, wTotal = 0, dataCount = 0, totalGames = 0

    for (const p of (players || [])) {
      const lvl = Math.min(Math.max(parseInt(p.skill_level) || 5, 1), 10)
      const w   = SKILL_WEIGHTS[lvl]
      const ms  = (p.map_stats || []).find(s => normMap(s.map) === nm)
      const score = ms ? playerMapScore(ms) : null

      if (score !== null) {
        wScore += score * w
        wTotal += w
        dataCount++
        totalGames += parseInt(ms.matches) || 0
      } else {
        wScore += 50 * w * 0.30
        wTotal += w * 0.30
      }
    }

    return {
      score:      wTotal > 0 ? wScore / wTotal : 50,
      coverage:   players.length > 0 ? dataCount / players.length : 0,
      totalGames,
    }
  }

  function buildMapPool(data) {
    // Always neutral perspective: faction1 (left) vs faction2 (right).
    // The extension doesn't root for either side — it just surfaces who has the
    // statistical edge on each map and the current veto state.
    const f1Players = data.teams?.faction1?.players || []
    const f2Players = data.teams?.faction2?.players || []
    if (f1Players.length === 0 && f2Players.length === 0) return ''

    // ── Build entity map from real-time veto data (if available) ─────────────
    // FACEIT API returns voting.map.entities[] with status: "available"|"drop"|"pick"
    // and selected_by: "faction1"|"faction2"|""
    const vetoEntities = data.voting?.map?.entities || []
    const entityByMap = {}
    for (const e of vetoEntities) {
      if (e.class_name) entityByMap[normMap(e.class_name)] = e
    }
    const hasLiveVeto = vetoEntities.length > 0

    // Fallback: if no entities but we have a picked map from voting.map.pick
    const pickedMap = data.map || ''

    // ML win probabilities for faction1, keyed by de_<map>. May be absent if
    // the ML service was unreachable on the backend.
    const winProb = data.win_prob || {}

    const entries = CS2_MAP_POOL.map(mapName => {
      const nm     = normMap(mapName)
      const entity = entityByMap[nm] || null
      const f1    = teamMapScore(f1Players, mapName)
      const f2    = teamMapScore(f2Players, mapName)

      // Sample-size bonus: faction with more games on the map gets a confidence
      // boost worth at most ±8 points.
      const totalG      = f1.totalGames + f2.totalGames
      const sampleBonus = totalG > 1
        ? ((f1.totalGames - f2.totalGames) / totalG) * 8
        : 0
      const adv = f1.score - f2.score + sampleBonus

      // ML win probability for faction1 (0..1), if available.
      const wp = (typeof winProb[mapName] === 'number') ? winProb[mapName] : null

      // Veto state from live data
      let vetoStatus  = null // null | "available" | "drop" | "pick"
      let vetoBy      = null // null | "faction1" | "faction2"
      if (entity) {
        vetoStatus = entity.status
        vetoBy     = entity.selected_by || null
      } else if (normMap(pickedMap) === nm) {
        vetoStatus = 'pick'
      }

      return { map: mapName, nm, f1, f2, adv, wp, vetoStatus, vetoBy }
    })

    // Sort: picks first → available by how decisive the ML prob is (distance
    // from 50%), falling back to stat advantage when ML is missing → banned last
    const decisiveness = e => e.wp !== null ? Math.abs(e.wp - 0.5) * 100 : Math.abs(e.adv)
    entries.sort((a, b) => {
      const order = s => s === 'pick' ? 0 : s === 'available' || !s ? 1 : 2
      const od = order(a.vetoStatus) - order(b.vetoStatus)
      if (od !== 0) return od
      return decisiveness(b) - decisiveness(a)
    })

    const rows = entries.map(e => {
      const mapShort = e.map.replace('de_', '').toUpperCase()
      const adv      = e.adv
      const noData   = e.f1.coverage < 0.2 && e.f2.coverage < 0.2

      let badge    = ''
      let rowClass = 'cs-map-row'

      if (e.vetoStatus === 'pick') {
        badge    = '<span class="cs-map-badge cs-map-badge--pick">PICK</span>'
        rowClass = 'cs-map-row cs-map-row--pick'
      } else if (e.vetoStatus === 'drop') {
        badge    = '<span class="cs-map-badge cs-map-badge--banned">забанена</span>'
        rowClass = 'cs-map-row cs-map-row--banned'
      } else if (noData) {
        badge = '<span class="cs-map-badge cs-map-badge--nodata">?</span>'
      }

      // Banned maps: hide bars, just show greyed-out name + badge
      if (e.vetoStatus === 'drop') {
        return `
          <div class="${rowClass}">
            <div class="cs-map-name-cell cs-map-name-cell--full">
              <span class="cs-map-name">${mapShort}</span>
              ${badge}
            </div>
          </div>
        `
      }

      // Primary signal: ML win-prob (faction1 perspective). Fall back to the
      // stat-advantage heuristic when ML is unavailable.
      let barPct, isPos, mainNum, mainCls, subNum
      if (e.wp !== null) {
        const pctF1   = e.wp * 100
        isPos         = pctF1 >= 50          // faction1 favoured
        const deltaPct = Math.abs(pctF1 - 50) // 0..50
        barPct        = (deltaPct / 50) * 48
        mainNum       = (isPos ? pctF1 : 100 - pctF1).toFixed(0) + '%'
        mainCls       = isPos ? 'f1' : 'f2'
        subNum        = (adv >= 0 ? '+' : '') + adv.toFixed(0) // dim stat-adv
      } else {
        const clamped = Math.min(Math.max(adv, -50), 50)
        barPct        = Math.abs(clamped) / 50 * 48
        isPos         = adv >= 0
        mainNum       = (adv >= 0 ? '+' : '') + adv.toFixed(0)
        mainCls       = isPos ? 'f1' : 'f2'
        subNum        = `${e.f1.score.toFixed(0)}% / ${e.f2.score.toFixed(0)}%`
      }

      return `
        <div class="${rowClass}">
          <div class="cs-map-name-cell">
            <span class="cs-map-name">${mapShort}</span>
            ${badge}
          </div>
          <div class="cs-map-bars">
            <div class="cs-adv-bar-wrap">
              <div class="cs-adv-bar ${isPos ? 'cs-adv-bar--pos' : 'cs-adv-bar--neg'}" style="width:${barPct}%"></div>
            </div>
            <div class="cs-map-wr-nums">
              <span class="cs-map-wr cs-map-wr--num cs-map-wr--${mainCls}">${mainNum}</span>
              <span class="cs-map-wr cs-map-wr--dim">${subNum}</span>
            </div>
          </div>
        </div>
      `
    }).join('')

    const liveIndicator = (hasLiveVeto && data.status === 'VOTING')
      ? '<span class="cs-live-dot"></span>'
      : ''
    const mlBadge = Object.keys(winProb).length > 0
      ? '<span class="cs-ml-tag" title="Прогноз ML-модели CounterStrafe">ML</span>'
      : ''

    // Live veto coach: when voting is in progress, lead with a short
    // recommendation derived from the ML probabilities of the still-available
    // maps — what to ban (most lopsided against either side) and what's safest.
    let vetoAdvice = ''
    if (data.status === 'VOTING') {
      const avail = entries.filter(e => e.vetoStatus === 'available' || !e.vetoStatus)
      const withWp = avail.filter(e => e.wp !== null)
      if (withWp.length >= 2) {
        // Map most decisive against faction1 / against faction2.
        const sortedByF1 = [...withWp].sort((a, b) => a.wp - b.wp) // ascending: worst-for-f1 first
        const worstForF1 = sortedByF1[0]      // f2's strong map
        const worstForF2 = sortedByF1[sortedByF1.length - 1] // f1's strong map
        const banForF1 = worstForF1.map.replace('de_', '').toUpperCase()
        const banForF2 = worstForF2.map.replace('de_', '').toUpperCase()
        vetoAdvice = `
          <div class="cs-veto-advice">
            <span class="cs-veto-advice-lbl">СОВЕТ ПО ВЕТО</span>
            <span class="cs-veto-advice-line"><b class="cs-f1">T1</b> бань <b>${banForF1}</b> (${(worstForF1.wp * 100).toFixed(0)}%)</span>
            <span class="cs-veto-advice-line"><b class="cs-f2">T2</b> бань <b>${banForF2}</b> (${(100 - worstForF2.wp * 100).toFixed(0)}%)</span>
          </div>
        `
      }
    }

    return `
      <div class="cs-section-label">КАРТЫ ${mlBadge}${liveIndicator}</div>
      ${vetoAdvice}
      ${rows}
    `
  }

  // ── FACEIT DOM veto overlay ───────────────────────────────────────────────
  // We inject coloured outlines + floating badges directly onto FACEIT's map cards.

  const CS_VETO_ATTR = 'data-cs-veto'

  function clearVetoOverlays() {
    document.querySelectorAll(`[${CS_VETO_ATTR}]`).forEach(el => el.removeAttribute(CS_VETO_ATTR))
    document.querySelectorAll('.cs-veto-badge').forEach(el => el.remove())
  }

  /** Walk up from el until we find a card-sized ancestor (80-400px wide & tall). */
  function findCardAncestor(el) {
    let node = el
    for (let i = 0; i < 8; i++) {
      if (!node || node === document.body) break
      const r = node.getBoundingClientRect()
      if (r.width >= 80 && r.width <= 400 && r.height >= 60) return node
      node = node.parentElement
    }
    return null
  }

  /** Find FACEIT's map card element for a given map name (e.g. "de_mirage"). */
  function findFaceitMapCard(mapName) {
    const full = 'de_' + normMap(mapName)

    // Strategy 1: <img src="…de_mirage…">
    const img = document.querySelector(`img[src*="${full}"]`)
    if (img) return findCardAncestor(img)

    // Strategy 2: element with inline background-image containing the map name
    const bgEl = document.querySelector(`[style*="${full}"]`)
    if (bgEl) return findCardAncestor(bgEl)

    return null
  }

  function positionVetoBadge(badge, card) {
    const r = card.getBoundingClientRect()
    badge.style.top  = (r.bottom - 24) + 'px'
    badge.style.left = (r.left + r.width / 2) + 'px'
  }

  function injectVetoOverlays(data) {
    clearVetoOverlays()
    if (!data.voting?.map?.entities?.length) return

    const f1Players = data.teams?.faction1?.players || []
    const f2Players = data.teams?.faction2?.players || []
    const winProb   = data.win_prob || {}

    for (const entity of data.voting.map.entities) {
      if (!entity.class_name) continue

      // Already banned — just dim the card, no recommendation needed
      if (entity.status === 'drop') {
        const card = findFaceitMapCard(entity.class_name)
        if (card) card.setAttribute(CS_VETO_ATTR, 'banned')
        continue
      }

      if (entity.status !== 'available') continue

      // Prefer the ML win-probability; fall back to the stat-advantage heuristic.
      let type = null, text = ''
      const wp = winProb[entity.class_name]
      if (typeof wp === 'number') {
        const pctF1 = wp * 100
        if      (pctF1 >= 58) { type = 'f1'; text = `T1 ${pctF1.toFixed(0)}%` }
        else if (pctF1 <= 42) { type = 'f2'; text = `T2 ${(100 - pctF1).toFixed(0)}%` }
      } else {
        const f1  = teamMapScore(f1Players, entity.class_name)
        const f2  = teamMapScore(f2Players, entity.class_name)
        const adv = f1.score - f2.score
        if      (adv >=  12) { type = 'f1'; text = `T1 +${adv.toFixed(0)}` }
        else if (adv <= -12) { type = 'f2'; text = `T2 +${Math.abs(adv).toFixed(0)}` }
      }

      const card = findFaceitMapCard(entity.class_name)
      if (!card) continue

      card.setAttribute(CS_VETO_ATTR, type || 'neutral')

      if (type) {
        const badge = document.createElement('div')
        badge.className = `cs-veto-badge cs-veto-badge--${type}`
        badge.textContent = text
        document.body.appendChild(badge)
        positionVetoBadge(badge, card)
      }
    }
  }

  // ── Inline stats — injected into FACEIT's own player cards ──────────────
  // Adds a thin stats strip directly below each player row in FACEIT's UI
  // (roster widget, scoreboard table, accolades carousel — wherever a player
  // nickname is shown). Lifetime KD/WR/HS plus map-specific KD/WR when the
  // map is known. Independent of the bottom panel and can be toggled
  // separately from the popup.

  const INLINE_STRIP_ATTR = 'data-cs-inline'   // marker on our injected element
  const INLINE_ROW_ATTR   = 'data-cs-inline-row' // marker on the FACEIT row we attached under
  let inlineLatestData = null                   // last prematch payload, used for re-injection on FACEIT re-renders
  let inlineObserver   = null

  function clearInlineStats() {
    document.querySelectorAll(`[${INLINE_STRIP_ATTR}]`).forEach(el => el.remove())
    document.querySelectorAll(`[${INLINE_ROW_ATTR}]`).forEach(el => el.removeAttribute(INLINE_ROW_ATTR))
    if (inlineObserver) {
      inlineObserver.disconnect()
      inlineObserver = null
    }
    inlineLatestData = null
  }

  // Find the OUTERMOST sensible row container for a nickname element.
  // Walks up the full ancestry and keeps the largest row-shaped candidate —
  // this avoids matching an inner sub-row (avatar+name only) when the actual
  // FACEIT "card" wraps multiple inner elements.
  function findInlineRow(nickEl) {
    let candidate = null
    let curr = nickEl.parentElement
    for (let i = 0; i < 10 && curr && curr !== document.body; i++) {
      const r = curr.getBoundingClientRect()
      const cls = (curr.className || '').toString()
      const isRowShaped = r.width >= 200 && r.height >= 40 && r.height <= 200
      // Hint: FACEIT class names that strongly imply a row container.
      const isLikelyRow = /PlayerCard|AccoladeCard|Row|styles__Row/i.test(cls)
      if (isRowShaped && (isLikelyRow || !candidate)) {
        candidate = curr
      }
      // Stop early if we've gone past anything that could plausibly be a card.
      if (r.height > 200 || r.width > 1800) break
      curr = curr.parentElement
    }
    return candidate
  }

  // True if this row already has our strip (own marker), or sits inside / wraps
  // another row that does. Prevents double-injection when a player nickname
  // appears in multiple nested elements within the same FACEIT card.
  function hasInlineMarkerAnywhere(row) {
    let p = row
    while (p && p !== document.body) {
      if (p.getAttribute && p.getAttribute(INLINE_ROW_ATTR) === '1') return true
      p = p.parentElement
    }
    return !!row.querySelector(`[${INLINE_ROW_ATTR}="1"]`)
  }

  function fmtMatches(n) {
    const v = parseInt(n) || 0
    if (v >= 10000) return Math.round(v / 1000) + 'k'
    if (v >= 1000)  return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
    return String(v)
  }

  // Estimate lifetime kills-per-round from map_stats (FACEIT lifetime payload
   // doesn't include KR directly, only per-map). Weighted by matches on each map.
  function computeLifetimeKR(player) {
    const stats = player.map_stats || []
    let acc = 0, total = 0
    for (const ms of stats) {
      const kr = parseFloat(ms.kr_ratio) || 0
      const games = parseInt(ms.matches) || 0
      if (kr > 0 && games > 0) {
        acc += kr * games
        total += games
      }
    }
    return total > 0 ? acc / total : null
  }

  function fmtAvg(kr) {
    // Avg kills per match: KR (kills/round) × ~22 rounds (CS2 MR12 typical match).
    if (!isFinite(kr) || kr <= 0) return null
    return (kr * 22).toFixed(1)
  }

  // ── Lite impact score ────────────────────────────────────────────────────
  // Demo-free proxy for "how much this player contributes to winning". The real
  // CounterStrafe rating (RSI/WPA) needs round-by-round demo data; this composite
  // approximates it from FACEIT lifetime numbers. 0–100, 50 ≈ average.
  //   WR  40%  — directly measures winning (the whole point)
  //   KD  25%  — frag impact
  //   KR  20%  — kills per round (consistency, less luck than KD)
  //   HS  15%  — raw mechanical skill
  // Returns { score, padder } where padder=true flags a fragger whose KD is
  // strong but whose winrate doesn't follow — classic stat-padder pattern.
  function computeImpact(player) {
    const wr = parseFloat(player.win_rate)  || 0
    const kd = parseFloat(player.kd_ratio)  || 0
    const hs = parseFloat(player.hs_percent) || 0
    const kr = computeLifetimeKR(player) || 0
    if (!wr && !kd) return null

    const clamp01 = x => Math.min(Math.max(x, 0), 1)
    // Normalisations (0..1):
    //   WR  44% → 0,  50% → 0.5,  56% → 1
    //   KD  0.8 → 0,  1.0 → 0.5,  1.3 → 1
    //   KR  0.55→ 0,  0.7 → 0.5,  0.9 → 1
    //   HS  30  → 0,  45  → 0.5,  60  → 1
    const wrN = clamp01((wr - 44) / 12)
    const kdN = clamp01((kd - 0.8) / 0.5)
    const krN = kr > 0 ? clamp01((kr - 0.55) / 0.35) : kdN
    const hsN = clamp01((hs - 30) / 30)

    const score = Math.round((wrN * 0.40 + kdN * 0.25 + krN * 0.20 + hsN * 0.15) * 100)

    // Stat-padder: solid fragging (KD ≥ 1.10) but the team doesn't win with them
    // (WR ≤ 48%) — KD is misleading you about their value.
    const padder = kd >= 1.10 && wr <= 48

    return { score, padder }
  }

  function impactTier(score) {
    if (score >= 65) return 'hi'
    if (score >= 50) return 'mid'
    if (score >= 38) return 'lo'
    return 'vlo'
  }

  // ── Smurf / booster detection ────────────────────────────────────────────
  // Pure heuristic on FACEIT lifetime numbers — no demos. The signature: an
  // account with few games but a rating that doesn't match a fresh account
  // (high ELO / level), often with an unusually high HS%. Returns null (clean)
  // or { level: 'maybe' | 'likely', reasons: string[] }.
  function detectSmurf(player) {
    const matches = parseInt(player.matches)      || 0
    const elo     = parseInt(player.elo)          || 0
    const lvl     = parseInt(player.skill_level)  || 0
    const hs      = parseFloat(player.hs_percent) || 0
    const kd      = parseFloat(player.kd_ratio)   || 0
    if (matches <= 0) return null

    let score = 0
    const reasons = []
    if (matches < 100 && elo >= 1700) { score += 2; reasons.push(`${matches} матчей, но ${elo} ELO`) }
    else if (matches < 250 && elo >= 2000) { score += 2; reasons.push(`${matches} матчей, ${elo} ELO`) }
    else if (matches < 450 && elo >= 2300) { score += 1; reasons.push(`всего ${matches} матчей при ${elo} ELO`) }
    if (lvl >= 9 && matches < 300) { score += 1; reasons.push(`lvl ${lvl} за <300 игр`) }
    if (hs >= 55 && matches < 500) { score += 1; reasons.push(`HS ${hs.toFixed(0)}%`) }
    if (kd >= 1.4 && matches < 500) { score += 1; reasons.push(`KD ${kd.toFixed(2)}`) }

    if (score >= 3) return { level: 'likely', reasons }
    if (score >= 2) return { level: 'maybe',  reasons }
    return null
  }

  // ── Recent form / win streak ─────────────────────────────────────────────
  // `recent_form` from the API is the last ~30 W/L, newest first (true = win).
  // Returns null if no data, otherwise { streak, hot, recent } where:
  //   streak = length of the current run of wins from the most recent match
  //   hot    = streak >= 3 (the "on fire" threshold)
  //   recent = the first 5 results (for a tiny W/L dot strip)
  function recentFormInfo(player) {
    const rf = Array.isArray(player.recent_form) ? player.recent_form : null
    if (!rf || rf.length === 0) return null
    let streak = 0
    for (const w of rf) { if (w) streak++; else break }
    return { streak, hot: streak >= 3, recent: rf.slice(0, 5) }
  }

  // Renders a tiny W/L dot row for the last few matches.
  function formDots(recent) {
    return recent.map(w => `<span class="cs-form-dot cs-form-dot--${w ? 'w' : 'l'}"></span>`).join('')
  }

  // ── Party synergy ────────────────────────────────────────────────────────
  // `party_synergy` from the API is { matches, wins } shared by the party.
  function partySynergyInfo(player) {
    const ps = player.party_synergy
    if (!ps || typeof ps.matches !== 'number' || ps.matches < 3) return null
    const wr = ps.matches > 0 ? Math.round((ps.wins / ps.matches) * 100) : 0
    return { matches: ps.matches, wins: ps.wins, wr }
  }

  function buildCopyString(player) {
    const kr = computeLifetimeKR(player)
    const parts = [
      `KD ${fmtKD(player.kd_ratio)}`,
      `WR ${fmtWR(player.win_rate)}`,
    ]
    if (player.hs_percent) parts.push(`HS ${parseFloat(player.hs_percent).toFixed(0)}%`)
    if (kr)                parts.push(`KR ${kr.toFixed(2)}`)
    const avg = fmtAvg(kr)
    if (avg)               parts.push(`AVG ${avg}`)
    if (player.matches)    parts.push(`${fmtMatches(player.matches)} матчей`)
    const nick = (player.nickname || '').toString()
    return nick ? `${nick} — ${parts.join(' · ')}` : parts.join(' · ')
  }

  function buildInlineStrip(player, currentMap) {
    const kd = fmtKD(player.kd_ratio)
    const wr = fmtWR(player.win_rate)
    const hs = player.hs_percent ? parseFloat(player.hs_percent).toFixed(0) + '%' : null
    const krRaw = computeLifetimeKR(player)
    const kr = krRaw ? krRaw.toFixed(2) : null
    const avg = fmtAvg(krRaw)
    const matches = player.matches ? fmtMatches(player.matches) : null

    const imp = computeImpact(player)
    const impBlock = imp
      ? `<span class="cs-inline-imp cs-inline-imp--${impactTier(imp.score)}" title="Impact score — вклад в победу (0–100)">${imp.score}${imp.padder ? ' ⚠' : ''}</span>`
      : ''

    const smurf = detectSmurf(player)
    const smurfBlock = smurf
      ? `<span class="cs-inline-smurf cs-inline-smurf--${smurf.level}" title="${escapeHtml('Возможный смурф/буст: ' + smurf.reasons.join(', '))}">🚩</span>`
      : ''

    const form = recentFormInfo(player)
    const streakBlock = (form && form.hot)
      ? `<span class="cs-inline-streak" title="${form.streak} побед подряд">🔥${form.streak >= 5 ? form.streak : ''}</span>`
      : ''

    const syn = partySynergyInfo(player)
    const synBlock = syn
      ? `<span class="cs-inline-syn" title="Эта пати: ${syn.matches} матчей вместе, ${syn.wr}% побед">👥${syn.wr}%</span>`
      : ''

    // Map-specific lifetime stats for the map being played
    let mapBlock = ''
    if (currentMap && Array.isArray(player.map_stats)) {
      const nmCurr = normMap(currentMap)
      const ms = player.map_stats.find(s => normMap(s.map) === nmCurr)
      if (ms && parseFloat(ms.win_rate) > 0) {
        const mapLabel = currentMap.replace(/^de_/i, '').toUpperCase()
        mapBlock = `<span class="cs-inline-stat cs-inline-stat--map"><span class="cs-inline-lbl">${escapeHtml(mapLabel)}</span> ${fmtKD(ms.kd_ratio)}/${fmtWR(ms.win_rate)}</span>`
      }
    }

    const copyText = buildCopyString(player)
    const copyBtn = `
      <button class="cs-inline-copy" type="button" title="Скопировать статистику" data-cs-copy="${escapeHtml(copyText)}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </button>
    `

    // AVG (≈KR×22) is shown in the copy string + title only — kept out of the
    // strip itself so all the real stats + impact pill fit on one line.
    void avg

    return `
      <div class="cs-inline-strip" ${INLINE_STRIP_ATTR}="1">
        <div class="cs-inline-capsule">
          ${impBlock}${streakBlock}${smurfBlock}${synBlock}
          <span class="cs-inline-stat"><span class="cs-inline-lbl">KD</span> ${kd}</span>
          <span class="cs-inline-stat"><span class="cs-inline-lbl">WR</span> ${wr}</span>
          ${hs ? `<span class="cs-inline-stat"><span class="cs-inline-lbl">HS</span> ${hs}</span>` : ''}
          ${kr ? `<span class="cs-inline-stat"><span class="cs-inline-lbl">KR</span> ${kr}</span>` : ''}
          ${matches ? `<span class="cs-inline-stat"><span class="cs-inline-lbl">M</span> ${matches}</span>` : ''}
          ${copyBtn}
          ${mapBlock}
        </div>
      </div>
    `
  }

  // Delegated click handler for copy / share buttons — written once per page.
  if (!window.__csCopyHandlerInstalled) {
    window.__csCopyHandlerInstalled = true
    document.addEventListener('click', (ev) => {
      const copyBtn = ev.target.closest('.cs-inline-copy')
      if (copyBtn) {
        ev.preventDefault()
        ev.stopPropagation()
        const txt = copyBtn.getAttribute('data-cs-copy') || ''
        navigator.clipboard.writeText(txt).then(
          () => {
            copyBtn.classList.add('cs-inline-copy--copied')
            setTimeout(() => copyBtn.classList.remove('cs-inline-copy--copied'), 1500)
          },
          () => { /* ignore */ },
        )
        return
      }
      const shareBtn = ev.target.closest('.cs-link--share')
      if (shareBtn) {
        ev.preventDefault()
        ev.stopPropagation()
        const mid = shareBtn.getAttribute('data-cs-share') || ''
        const url = `https://counterstrafe.pro/match/${mid}/analytics`
        navigator.clipboard.writeText(url).then(
          () => {
            const orig = shareBtn.textContent
            shareBtn.textContent = '✓ Ссылка скопирована'
            setTimeout(() => { shareBtn.textContent = orig }, 1600)
          },
          () => { /* ignore */ },
        )
      }
    }, true)
  }

  function injectInlineStats(data) {
    if (!data || !data.teams) return
    inlineLatestData = data

    // Build nickname → player map (case-insensitive)
    const byNick = new Map()
    for (const fac of ['faction1', 'faction2']) {
      for (const p of (data.teams[fac]?.players || [])) {
        if (p.nickname) byNick.set(p.nickname.toLowerCase(), p)
      }
    }
    if (byNick.size === 0) return

    // Pause observer while we mutate — otherwise our own DOM additions trigger
    // a re-injection cascade that piles up duplicate strips.
    const wasObserving = inlineObserver !== null
    if (wasObserving) inlineObserver.disconnect()

    // Always start from a clean slate. FACEIT re-renders frequently, which
    // can orphan strips or wipe our markers, causing duplicate injection on
    // the next observer tick. Clear-then-rebuild is simpler and avoids that.
    document.querySelectorAll(`[${INLINE_STRIP_ATTR}="1"]`).forEach(el => el.remove())
    document.querySelectorAll(`[${INLINE_ROW_ATTR}="1"]`).forEach(el => el.removeAttribute(INLINE_ROW_ATTR))

    const currentMap = data.map || ''

    // Find every Nickname__Name node in FACEIT's DOM
    const nodes = document.querySelectorAll('[class*="Nickname__Name"]')

    // Position-based dedup: if two nickname elements resolve to rows at the
    // same on-screen spot (inner + outer wrapper of the same card), keep one.
    const seenAtPosition = new Set()

    for (const node of nodes) {
      // Skip hidden / zero-size duplicate name spans that FACEIT renders for
      // tooltips and accessibility — they cause double injection.
      if (node.offsetWidth < 20 || node.offsetHeight < 10) continue

      const nick = (node.textContent || '').trim().toLowerCase()
      if (!nick) continue
      const player = byNick.get(nick)
      if (!player) continue

      const row = findInlineRow(node)
      if (!row) continue

      const rect = row.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue  // not in layout

      // Bucket position into ~10px slots so tiny render differences don't slip
      // through. Two name elements at roughly the same on-screen location must
      // resolve to a single strip.
      const posKey = `${nick}|${Math.round((rect.top + window.scrollY) / 10)}|${Math.round(rect.left / 10)}`
      if (seenAtPosition.has(posKey)) continue
      seenAtPosition.add(posKey)

      if (hasInlineMarkerAnywhere(row)) continue

      row.setAttribute(INLINE_ROW_ATTR, '1')
      row.insertAdjacentHTML('afterend', buildInlineStrip(player, currentMap))
    }

    // Resume / start observer after mutations are done. We use a microtask so
    // the layout finishes before we reattach (avoids picking up our own writes).
    if (wasObserving && inlineObserver) {
      Promise.resolve().then(() => {
        if (inlineObserver) inlineObserver.observe(document.body, { childList: true, subtree: true })
      })
    } else {
      startInlineObserver()
    }
  }

  // FACEIT re-renders parts of the scoreboard (tab switches, accolade carousel
  // pagination, live updates). Use a debounced MutationObserver to re-inject.
  function startInlineObserver() {
    if (inlineObserver) return
    let t = null
    inlineObserver = new MutationObserver(() => {
      clearTimeout(t)
      t = setTimeout(() => {
        if (inlineLatestData) injectInlineStats(inlineLatestData)
      }, 400)
    })
    inlineObserver.observe(document.body, { childList: true, subtree: true })
  }

  // ── Panel HTML builders ───────────────────────────────────────────────────
  const skelRow = '<div class="cs-skel-row"><div class="cs-skel-avatar"></div><div class="cs-skel-lines"><div class="cs-skel-line cs-skel-line-wide"></div><div class="cs-skel-line cs-skel-line-narrow"></div></div></div>'
  const skelMapRow = '<div class="cs-skel-bar"></div>'

  function buildSkeleton() {
    return `
      <div class="cs-panel-skeleton">
        <div class="cs-skel-col">${Array(5).fill(skelRow).join('')}</div>
        <div class="cs-skel-center">${Array(7).fill(skelMapRow).join('')}</div>
        <div class="cs-skel-col">${Array(5).fill(skelRow).join('')}</div>
      </div>
    `
  }

  function buildError(msg, notLoggedIn) {
    if (notLoggedIn) {
      return `
        <div class="cs-panel-error">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
          </svg>
          <p>Войди на <a href="https://counterstrafe.pro" target="_blank" rel="noopener">counterstrafe.pro</a> для просмотра аналитики</p>
        </div>
      `
    }
    return `
      <div class="cs-panel-error">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>
        </svg>
        <p>${msg || 'Не удалось загрузить данные'}</p>
      </div>
    `
  }

  // FACEIT's CSP forbids inline event handlers (`script-src-attr 'none'`),
  // so we cannot use onerror= directly in HTML. Instead emit a placeholder
  // by default and let the error listener (attached after insert) swap it in
  // when the real avatar fails or is missing.
  const AVATAR_PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><rect width='32' height='32' fill='%23263144' rx='4'/><circle cx='16' cy='13' r='5' fill='%23475569'/><path d='M6 28c2-5 6-7 10-7s8 2 10 7v4H6z' fill='%23475569'/></svg>"

  function buildPlayerRow(player, side) {
    const lvl = Math.min(Math.max(parseInt(player.skill_level) || 1, 1), 10)
    const sideClass = side === 'faction1' ? 'cs-side-ct' : 'cs-side-t'
    const kdVal = fmtKD(player.kd_ratio)
    const wrVal = fmtWR(player.win_rate)
    const elo = player.elo || '?'
    const avatarSrc = player.avatar || AVATAR_PLACEHOLDER

    const imp = computeImpact(player)
    const impBadge = imp
      ? `<span class="cs-imp cs-imp--${impactTier(imp.score)}" title="Impact score (вклад в победу)">${imp.score}${imp.padder ? '<span class="cs-imp-warn" title="Высокий KD, но команда не выигрывает — возможный стат-паддер">⚠</span>' : ''}</span>`
      : ''

    const smurf = detectSmurf(player)
    const smurfFlag = smurf
      ? `<span class="cs-smurf cs-smurf--${smurf.level}" title="${escapeHtml('Возможный смурф/буст: ' + smurf.reasons.join(', '))}">🚩</span>`
      : ''

    const form = recentFormInfo(player)
    const streakBadge = (form && form.hot)
      ? `<span class="cs-streak" title="${form.streak} побед подряд">🔥${form.streak >= 5 ? form.streak : ''}</span>`
      : ''
    const formDotsHtml = form
      ? `<span class="cs-form-dots" title="Последние матчи (W/L), новые слева">${formDots(form.recent)}</span>`
      : ''

    const syn = partySynergyInfo(player)
    const synTag = syn
      ? `<span class="cs-syn" title="Эта пати: ${syn.matches} матчей вместе, ${syn.wr}% побед">👥 ${syn.wr}%</span>`
      : ''

    return `
      <div class="cs-player-row ${sideClass}">
        <img class="cs-player-avatar" src="${escapeHtml(avatarSrc)}" alt="" loading="lazy" data-cs-fallback="${AVATAR_PLACEHOLDER}" />
        <div class="cs-player-info">
          <div class="cs-player-nick">${escapeHtml(player.nickname)}${streakBadge}${smurfFlag}</div>
          <div class="cs-player-stats">
            ${impBadge}
            <span class="cs-elo" title="ELO">${elo}</span>
            <span class="cs-skill-dot" style="background:${skillColor(lvl)}" title="Level ${lvl}"></span>
            <span class="cs-stat" title="K/D Ratio">${kdVal} KD</span>
            <span class="cs-stat cs-stat-wr" title="Win Rate">${wrVal}</span>
            ${formDotsHtml}
            ${synTag}
          </div>
        </div>
      </div>
    `
  }

  // Attach error fallback to all avatars in the panel — needed because FACEIT's
  // CSP blocks inline onerror handlers. Called every time we replace body.
  function attachAvatarFallbacks(root) {
    const imgs = root.querySelectorAll('img.cs-player-avatar')
    for (const img of imgs) {
      img.addEventListener('error', () => {
        const fb = img.getAttribute('data-cs-fallback')
        if (fb && img.src !== fb) img.src = fb
      }, { once: true })
    }
  }

  function buildTeam(team, side) {
    const players = (team.players || []).map(p => buildPlayerRow(p, side)).join('')
    const dotClass = side === 'faction1' ? 'cs-side-ct-dot' : 'cs-side-t-dot'
    return `
      <div class="cs-team">
        <div class="cs-team-header">
          <span class="cs-team-dot ${dotClass}"></span>
          <span class="cs-team-name">${escapeHtml(team.name || 'Team')}</span>
        </div>
        ${players}
      </div>
    `
  }

  // Find which faction a player_id belongs to (for the personal prep line).
  function factionOf(data, playerID) {
    if (!playerID) return null
    if ((data.teams.faction1.players || []).some(p => p.player_id === playerID)) return 'faction1'
    if ((data.teams.faction2.players || []).some(p => p.player_id === playerID)) return 'faction2'
    return null
  }

  // A short personal prep note for the logged-in player: which team they're on,
  // their best & worst map by lifetime KD (out of the maps still in play).
  function buildPrepNote(data, playerID) {
    const fac = factionOf(data, playerID)
    if (!fac) return ''
    const me = (data.teams[fac].players || []).find(p => p.player_id === playerID)
    if (!me || !Array.isArray(me.map_stats) || me.map_stats.length === 0) return ''

    // Only consider maps that aren't banned.
    const banned = new Set(
      (data.voting?.map?.entities || [])
        .filter(e => e.status === 'drop' && e.class_name)
        .map(e => normMap(e.class_name)),
    )
    const usable = me.map_stats
      .filter(ms => parseFloat(ms.win_rate) > 0 && (parseInt(ms.matches) || 0) >= 5 && !banned.has(normMap(ms.map)))
      .map(ms => ({ map: ms.map, kd: parseFloat(ms.kd_ratio) || 0, wr: parseFloat(ms.win_rate) || 0 }))
    if (usable.length < 2) return ''

    usable.sort((a, b) => b.kd - a.kd)
    const best = usable[0]
    const worst = usable[usable.length - 1]
    const teamName = escapeHtml(data.teams[fac].name || (fac === 'faction1' ? 'Team 1' : 'Team 2'))
    return `
      <div class="cs-prep">
        <span class="cs-prep-lbl">ТЫ В ${teamName}</span>
        <span class="cs-prep-item">сильная: <b>${escapeHtml(best.map)}</b> ${best.kd.toFixed(2)} KD</span>
        <span class="cs-prep-item cs-prep-item--weak">слабая: <b>${escapeHtml(worst.map)}</b> ${worst.kd.toFixed(2)} KD</span>
      </div>
    `
  }

  function buildContent(data, playerID) {
    const t1 = buildTeam(data.teams.faction1, 'faction1')
    const t2 = buildTeam(data.teams.faction2, 'faction2')
    const mapPool = buildMapPool(data)
    const centerCol = mapPool
      ? `<div class="cs-map-col">${mapPool}</div>`
      : `<div class="cs-col-divider"></div>`

    const matchID = encodeURIComponent(data.match_id)
    const prep = buildPrepNote(data, playerID)
    // Grenade lineups link — only useful once a map is locked in.
    const pickedMap = data.map || (data.voting?.map?.entities || []).find(e => e.status === 'pick')?.class_name || ''
    const nadeLink = pickedMap
      ? `<a href="https://counterstrafe.pro/match/${matchID}/grenades" target="_blank" rel="noopener" class="cs-link cs-link--nade">💣 Раскидки на ${escapeHtml(pickedMap.replace(/^de_/i, '').toUpperCase())}</a>`
      : ''

    return `
      <div class="cs-panel-body">
        ${t1}
        ${centerCol}
        ${t2}
      </div>
      ${prep}
      <div class="cs-footer">
        ${nadeLink}
        <a href="https://counterstrafe.pro/match/${matchID}/coach" target="_blank" rel="noopener" class="cs-link cs-link--coach">🧠 AI-разбор</a>
        <button class="cs-link cs-link--share" type="button" data-cs-share="${matchID}" title="Скопировать ссылку на разбор матча">🔗 Поделиться</button>
        <a href="https://counterstrafe.pro/match/${matchID}/analytics" target="_blank" rel="noopener" class="cs-link">Открыть аналитику →</a>
      </div>
    `
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // ── Panel management ──────────────────────────────────────────────────────
  function getOrCreatePanel() {
    let panel = document.getElementById(PANEL_ID)
    if (panel) return panel

    panel = document.createElement('div')
    panel.id = PANEL_ID
    panel.setAttribute('data-collapsed', panelCollapsed ? '1' : '0')

    panel.innerHTML = `
      <div class="cs-panel-header">
        <div class="cs-panel-logo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#3b82f6">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
          <span>CounterStrafe</span>
        </div>
        <button class="cs-toggle-btn" title="Collapse/expand panel" aria-label="Toggle panel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
      </div>
    `

    document.body.appendChild(panel)

    // Toggle collapse
    panel.querySelector('.cs-toggle-btn').addEventListener('click', () => {
      const collapsed = panel.getAttribute('data-collapsed') === '1'
      panel.setAttribute('data-collapsed', collapsed ? '0' : '1')
      saveCollapsed(!collapsed)
    })

    return panel
  }

  function replaceBodyContent(panel, html) {
    const header = panel.querySelector('.cs-panel-header')
    while (panel.lastChild !== header) panel.removeChild(panel.lastChild)
    panel.insertAdjacentHTML('beforeend', html)
  }

  function setPanelLoading() {
    const panel = getOrCreatePanel()
    replaceBodyContent(panel, `<div class="cs-panel-body">${buildSkeleton()}</div>`)
  }

  function setPanelContent(html) {
    const panel = getOrCreatePanel()
    replaceBodyContent(panel, html)
    attachAvatarFallbacks(panel)
  }

  function removePanel() {
    stopVetoPoll()
    clearVetoOverlays()
    clearInlineStats()
    const panel = document.getElementById(PANEL_ID)
    if (panel) panel.remove()
    currentMatchID = null
  }

  // ── Main logic ────────────────────────────────────────────────────────────

  let vetoPollTimer = null  // setInterval id for veto polling

  function stopVetoPoll() {
    if (vetoPollTimer !== null) {
      clearInterval(vetoPollTimer)
      vetoPollTimer = null
    }
  }

  let lastPlayerID = null  // remembered from the initial fetch

  async function refreshVeto(matchID) {
    if (currentMatchID !== matchID) { stopVetoPoll(); return }

    const result = await chrome.runtime.sendMessage({ type: 'FETCH_PREMATCH', matchID })
    if (currentMatchID !== matchID) { stopVetoPoll(); return }
    if (!result || result.error || !result.data) return // silent — keep showing last good state
    if (!result.data.teams) return

    // Only swap the map column — re-rendering the whole panel every 4s causes
    // avatars to refetch and the player list to flash. Map veto state is the
    // only thing that actually changes during VOTING.
    const panel  = document.getElementById(PANEL_ID)
    const mapCol = panel && panel.querySelector('.cs-map-col')
    const newMapHTML = buildMapPool(result.data)
    if (mapCol && newMapHTML) {
      mapCol.innerHTML = newMapHTML
    } else {
      // Fallback: structure changed (e.g. first time map column appears) —
      // rebuild the whole panel.
      setPanelContent(buildContent(result.data, lastPlayerID ?? result.playerID))
    }

    if (result.data.status === 'VOTING') {
      injectVetoOverlays(result.data)
    } else {
      clearVetoOverlays()
      stopVetoPoll()
    }
  }

  async function loadMatchAnalytics(matchID) {
    if (currentMatchID === matchID) return // already loaded
    currentMatchID = matchID
    stopVetoPoll()

    if (panelEnabled) setPanelLoading()

    const result = await chrome.runtime.sendMessage({ type: 'FETCH_PREMATCH', matchID })

    // Guard: user may have navigated to a different match while request was in flight
    if (currentMatchID !== matchID) return

    if (!result) {
      if (panelEnabled) setPanelContent(`<div class="cs-panel-body">${buildError('Extension error')}</div>`)
      return
    }
    if (result.error) {
      const isAuth = result.status === 401 || result.status === 403
      const msg = result.timeout
        ? 'Сервер обрабатывает матч дольше обычного. Попробуй обновить страницу через минуту.'
        : result.error
      if (panelEnabled) setPanelContent(`<div class="cs-panel-body">${buildError(msg, isAuth)}</div>`)
      return
    }
    if (!result.data) {
      if (panelEnabled) setPanelContent(`<div class="cs-panel-body">${buildError('No data')}</div>`)
      return
    }
    if (!result.data.teams || !result.data.teams.faction1 || !result.data.teams.faction2) {
      if (panelEnabled) setPanelContent(`<div class="cs-panel-body">${buildError('Неполные данные матча')}</div>`)
      return
    }

    lastPlayerID = result.playerID ?? null
    if (panelEnabled) setPanelContent(buildContent(result.data, lastPlayerID))
    if (inlineEnabled) injectInlineStats(result.data)

    // If veto is live, poll every 4s and inject overlays immediately
    if (result.data.status === 'VOTING') {
      // Small delay so FACEIT's React has time to render the veto cards
      setTimeout(() => injectVetoOverlays(result.data), 600)
      vetoPollTimer = setInterval(() => refreshVeto(matchID), 4000)
    }
  }

  function handleNavigation() {
    if (!panelEnabled && !inlineEnabled) return
    const matchID = extractMatchID(location.href)
    if (!matchID) {
      removePanel()
      return
    }
    loadMatchAnalytics(matchID)
  }

  // ── SPA navigation detection ──────────────────────────────────────────────
  // FACEIT uses React Router — intercept pushState/replaceState
  const originalPushState = history.pushState.bind(history)
  const originalReplaceState = history.replaceState.bind(history)

  history.pushState = function (...args) {
    originalPushState(...args)
    setTimeout(handleNavigation, 100)
  }
  history.replaceState = function (...args) {
    originalReplaceState(...args)
    setTimeout(handleNavigation, 100)
  }

  window.addEventListener('popstate', () => setTimeout(handleNavigation, 100))

  // Fallback: watch for DOM changes that may accompany URL transitions FACEIT
  // performs without going through history.pushState (rare, but possible).
  // Debounced to avoid churning on every React re-render on the page.
  let obsTimer = null
  const observer = new MutationObserver(() => {
    clearTimeout(obsTimer)
    obsTimer = setTimeout(() => {
      const matchID = extractMatchID(location.href)
      if (matchID && matchID !== currentMatchID) {
        loadMatchAnalytics(matchID)
      } else if (!matchID && currentMatchID) {
        removePanel()
      }
    }, 300)
  })
  observer.observe(document.body, { childList: true, subtree: true })

  // ── Panel/inline enable/disable from popup ──────────────────────────────
  const STORAGE_KEY_PANEL  = 'cs_panel_enabled'
  const STORAGE_KEY_INLINE = 'cs_inline_enabled'

  // Load both toggles before running initial navigation.
  chrome.storage.local.get([STORAGE_KEY_PANEL, STORAGE_KEY_INLINE], (result) => {
    panelEnabled  = result[STORAGE_KEY_PANEL]  !== false
    inlineEnabled = result[STORAGE_KEY_INLINE] !== false
    handleNavigation()
  })

  function hidePanelOnly() {
    stopVetoPoll()
    clearVetoOverlays()
    const panel = document.getElementById(PANEL_ID)
    if (panel) panel.remove()
  }

  // Listen for toggle messages from popup. Toggling either mode never wipes the
  // other — only the affected surface is rebuilt or torn down.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SET_PANEL_ENABLED') {
      panelEnabled = msg.enabled
      if (!panelEnabled) {
        hidePanelOnly()
      } else {
        // Reset currentMatchID so loadMatchAnalytics re-fetches the panel
        currentMatchID = null
        handleNavigation()
      }
    }
    if (msg.type === 'SET_INLINE_ENABLED') {
      inlineEnabled = msg.enabled
      if (!inlineEnabled) {
        clearInlineStats()
      } else {
        // If we already have data cached for this match, just re-inject; otherwise
        // run navigation which will fetch.
        currentMatchID = null
        handleNavigation()
      }
    }
  })
})()
