// CounterStrafe Analytics — Service Worker
// Handles API requests and cookie auth on behalf of content scripts.

const CS_ORIGIN = 'https://counterstrafe.pro'
const API_BASE = CS_ORIGIN + '/api/v1'

/**
 * Get the cs_token cookie from counterstrafe.pro.
 * Returns the token string or null if not logged in.
 */
async function getAuthToken() {
  try {
    const cookie = await chrome.cookies.get({ url: CS_ORIGIN, name: 'cs_token' })
    return cookie ? cookie.value : null
  } catch {
    return null
  }
}

/**
 * Fetch pre-match data for a FACEIT match ID.
 * Returns { data } on success or { error } on failure.
 */
async function fetchPrematch(matchID) {
  const token = await getAuthToken()
  const headers = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = 'Bearer ' + token
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000) // 10s timeout
  try {
    const resp = await fetch(`${API_BASE}/matches/${encodeURIComponent(matchID)}/prematch`, {
      headers,
      credentials: 'include',
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!resp.ok) {
      return { error: `HTTP ${resp.status}` }
    }
    const data = await resp.json()
    return { data }
  } catch (err) {
    clearTimeout(timeout)
    if (err.name === 'AbortError') return { error: 'Timeout' }
    return { error: err.message || 'Network error' }
  }
}

/**
 * Check if the user is logged in to CounterStrafe.
 */
async function checkAuth() {
  const token = await getAuthToken()
  if (!token) return { loggedIn: false }
  try {
    const resp = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: 'Bearer ' + token },
      credentials: 'include',
    })
    if (!resp.ok) return { loggedIn: false }
    const user = await resp.json()
    return { loggedIn: true, user }
  } catch {
    return { loggedIn: false }
  }
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH_PREMATCH') {
    // Fetch prematch data and current user in parallel so content script
    // knows which team the logged-in player is on.
    Promise.all([fetchPrematch(msg.matchID), checkAuth()]).then(([prematch, auth]) => {
      sendResponse({ ...prematch, playerID: auth.user?.player_id ?? null })
    })
    return true // async
  }
  if (msg.type === 'CHECK_AUTH') {
    checkAuth().then(sendResponse)
    return true // async
  }
})
