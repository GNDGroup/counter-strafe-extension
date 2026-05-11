// CounterStrafe Analytics — Popup Script

const STORAGE_KEY_PANEL  = 'cs_panel_enabled'
const STORAGE_KEY_INLINE = 'cs_inline_enabled'

function show(id) { document.getElementById(id)?.classList.remove('hidden') }
function hide(id) { document.getElementById(id)?.classList.add('hidden') }

async function init() {
  // ── Auth status ──────────────────────────────────────────────────────────
  try {
    const authResult = await chrome.runtime.sendMessage({ type: 'CHECK_AUTH' })
    hide('auth-loading')
    if (authResult?.loggedIn) {
      const nameEl = document.getElementById('auth-name')
      if (nameEl && authResult.user?.nickname) {
        nameEl.textContent = authResult.user.nickname
      }
      const avatarEl = document.getElementById('auth-avatar')
      const dotEl = document.getElementById('auth-dot')
      if (avatarEl && authResult.user?.avatar) {
        avatarEl.src = authResult.user.avatar
        avatarEl.classList.remove('hidden')
        dotEl?.classList.add('hidden')
      }
      show('auth-ok')
      hide('login-link')
    } else {
      show('auth-fail')
      show('login-link')
    }
  } catch {
    hide('auth-loading')
    show('auth-fail')
    show('login-link')
  }

  // ── Mode toggles (panel + inline are independent) ────────────────────────
  const panelToggle  = document.getElementById('panel-toggle')
  const inlineToggle = document.getElementById('inline-toggle')

  const stored = await chrome.storage.local.get([STORAGE_KEY_PANEL, STORAGE_KEY_INLINE])
  panelToggle.checked  = stored[STORAGE_KEY_PANEL]  !== false // default true
  inlineToggle.checked = stored[STORAGE_KEY_INLINE] !== false // default true

  async function notifyActiveTab(message) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => { /* no content script on this tab */ })
    }
  }

  panelToggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ [STORAGE_KEY_PANEL]: panelToggle.checked })
    notifyActiveTab({ type: 'SET_PANEL_ENABLED', enabled: panelToggle.checked })
  })

  inlineToggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ [STORAGE_KEY_INLINE]: inlineToggle.checked })
    notifyActiveTab({ type: 'SET_INLINE_ENABLED', enabled: inlineToggle.checked })
  })

  // ── Tab status ───────────────────────────────────────────────────────────
  hide('tab-loading')
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = tab?.url || ''
    const isFaceit = url.includes('faceit.com') && url.includes('/room/')
    if (isFaceit) {
      show('tab-faceit')
    } else {
      show('tab-other')
    }
  } catch {
    show('tab-other')
  }
}

document.addEventListener('DOMContentLoaded', init)
