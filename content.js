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

      // Veto state from live data
      let vetoStatus  = null // null | "available" | "drop" | "pick"
      let vetoBy      = null // null | "faction1" | "faction2"
      if (entity) {
        vetoStatus = entity.status
        vetoBy     = entity.selected_by || null
      } else if (normMap(pickedMap) === nm) {
        vetoStatus = 'pick'
      }

      return { map: mapName, nm, f1, f2, adv, vetoStatus, vetoBy }
    })

    // Sort: picks first → available by absolute advantage → banned/dropped last
    entries.sort((a, b) => {
      const order = s => s === 'pick' ? 0 : s === 'available' || !s ? 1 : 2
      const od = order(a.vetoStatus) - order(b.vetoStatus)
      if (od !== 0) return od
      return Math.abs(b.adv) - Math.abs(a.adv)
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

      // Advantage bar
      const clamped = Math.min(Math.max(adv, -50), 50)
      const barPct  = Math.abs(clamped) / 50 * 48
      const isPos   = adv >= 0
      const myWr    = e.f1.score.toFixed(0)
      const theirWr = e.f2.score.toFixed(0)

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
              <span class="cs-map-wr cs-map-wr--num cs-map-wr--${isPos ? 'f1' : 'f2'}">${adv >= 0 ? '+' : ''}${adv.toFixed(0)}</span>
              <span class="cs-map-wr cs-map-wr--dim">${myWr}%&hairsp;/&hairsp;${theirWr}%</span>
            </div>
          </div>
        </div>
      `
    }).join('')

    const liveIndicator = (hasLiveVeto && data.status === 'VOTING')
      ? '<span class="cs-live-dot"></span>'
      : ''

    return `
      <div class="cs-section-label">КАРТЫ ${liveIndicator}</div>
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

    for (const entity of data.voting.map.entities) {
      if (!entity.class_name) continue

      // Already banned — just dim the card, no recommendation needed
      if (entity.status === 'drop') {
        const card = findFaceitMapCard(entity.class_name)
        if (card) card.setAttribute(CS_VETO_ATTR, 'banned')
        continue
      }

      if (entity.status !== 'available') continue

      const f1  = teamMapScore(f1Players, entity.class_name)
      const f2  = teamMapScore(f2Players, entity.class_name)
      const adv = f1.score - f2.score

      // Neutral perspective: highlight which faction has the edge, don't
      // tell anyone what to pick or ban. Outline + numeric advantage badge.
      let type = null, text = ''
      if      (adv >=  12) { type = 'f1'; text = `T1 +${adv.toFixed(0)}` }
      else if (adv <= -12) { type = 'f2'; text = `T2 +${Math.abs(adv).toFixed(0)}` }

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

  // Find the FACEIT row container for a nickname element by walking up to
  // the first "row-shaped" ancestor (wide enough, not too tall).
  function findInlineRow(nickEl) {
    let curr = nickEl
    for (let i = 0; i < 8 && curr && curr !== document.body; i++) {
      const r = curr.getBoundingClientRect()
      // A row has to be wider than the nickname itself, taller than just a single
      // line of text, but not tall enough to be a card stack.
      if (r.width >= 200 && r.height >= 40 && r.height <= 160) return curr
      curr = curr.parentElement
    }
    return null
  }

  function buildInlineStrip(player, currentMap) {
    const kd = fmtKD(player.kd_ratio)
    const wr = fmtWR(player.win_rate)
    const hs = player.hs_percent ? parseFloat(player.hs_percent).toFixed(0) + '%' : null

    // Last-30 recent form, if available
    let recentBlock = ''
    if (player.recent_matches && parseInt(player.recent_matches) > 0) {
      const recentWr = parseFloat(player.recent_wr || 0).toFixed(0)
      recentBlock = `<span class="cs-inline-stat"><span class="cs-inline-lbl">L30</span> ${recentWr}%</span>`
    }

    // Map-specific lifetime stats for the map being played
    let mapBlock = ''
    if (currentMap && Array.isArray(player.map_stats)) {
      const nmCurr = normMap(currentMap)
      const ms = player.map_stats.find(s => normMap(s.map) === nmCurr)
      if (ms && parseFloat(ms.win_rate) > 0) {
        const mapLabel = currentMap.replace(/^de_/i, '').toUpperCase()
        mapBlock = `<span class="cs-inline-stat cs-inline-stat--map"><span class="cs-inline-lbl">${escapeHtml(mapLabel)}</span> ${fmtKD(ms.kd_ratio)} KD · ${fmtWR(ms.win_rate)}</span>`
      }
    }

    return `
      <div class="cs-inline-strip" ${INLINE_STRIP_ATTR}="1">
        <span class="cs-inline-stat"><span class="cs-inline-lbl">KD</span> ${kd}</span>
        <span class="cs-inline-stat"><span class="cs-inline-lbl">WR</span> ${wr}</span>
        ${hs ? `<span class="cs-inline-stat"><span class="cs-inline-lbl">HS</span> ${hs}</span>` : ''}
        ${recentBlock}
        ${mapBlock}
      </div>
    `
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

    const currentMap = data.map || ''

    // Find every Nickname__Name node in FACEIT's DOM
    const nodes = document.querySelectorAll('[class*="Nickname__Name"]')
    const seenRows = new WeakSet()

    for (const node of nodes) {
      const nick = (node.textContent || '').trim().toLowerCase()
      if (!nick) continue
      const player = byNick.get(nick)
      if (!player) continue

      const row = findInlineRow(node)
      if (!row || seenRows.has(row)) continue
      if (row.getAttribute(INLINE_ROW_ATTR) === '1') continue

      seenRows.add(row)
      row.setAttribute(INLINE_ROW_ATTR, '1')
      row.insertAdjacentHTML('afterend', buildInlineStrip(player, currentMap))
    }

    startInlineObserver()
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
    return `
      <div class="cs-player-row ${sideClass}">
        <img class="cs-player-avatar" src="${escapeHtml(avatarSrc)}" alt="" loading="lazy" data-cs-fallback="${AVATAR_PLACEHOLDER}" />
        <div class="cs-player-info">
          <div class="cs-player-nick">${escapeHtml(player.nickname)}</div>
          <div class="cs-player-stats">
            <span class="cs-elo" title="ELO">${elo}</span>
            <span class="cs-skill-dot" style="background:${skillColor(lvl)}" title="Level ${lvl}"></span>
            <span class="cs-stat" title="K/D Ratio">${kdVal} KD</span>
            <span class="cs-stat cs-stat-wr" title="Win Rate">${wrVal}</span>
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

  function buildContent(data) {
    const t1 = buildTeam(data.teams.faction1, 'faction1')
    const t2 = buildTeam(data.teams.faction2, 'faction2')
    const mapPool = buildMapPool(data)
    const centerCol = mapPool
      ? `<div class="cs-map-col">${mapPool}</div>`
      : `<div class="cs-col-divider"></div>`
    return `
      <div class="cs-panel-body">
        ${t1}
        ${centerCol}
        ${t2}
      </div>
      <div class="cs-footer">
        <a href="https://counterstrafe.pro/match/${encodeURIComponent(data.match_id)}/analytics" target="_blank" rel="noopener" class="cs-link">
          Открыть аналитику →
        </a>
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

  async function refreshVeto(matchID) {
    if (currentMatchID !== matchID) { stopVetoPoll(); return }

    const result = await chrome.runtime.sendMessage({ type: 'FETCH_PREMATCH', matchID })
    if (currentMatchID !== matchID) { stopVetoPoll(); return }
    if (!result || result.error || !result.data) return // silent — keep showing last good state
    if (!result.data.teams) return

    // Keep playerID from initial load (no need to re-auth every 4s)
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
      setPanelContent(buildContent(result.data))
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

    if (panelEnabled) setPanelContent(buildContent(result.data))
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
