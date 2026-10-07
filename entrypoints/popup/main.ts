import { browser } from 'wxt/browser'

import {
  apiKeyItem,
  apiSecretItem,
  authErrorItem,
  debugItem,
  pendingAuthItem,
  queueItem,
  sessionKeyItem,
  statusItem,
  thresholdItem,
  usernameItem,
} from '../../utils/storage'
import type { DebugInfo } from '../../utils/types'
import './style.css'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null
  if (!el) {
    throw new Error(`#${id} not found`)
  }
  return el
}

/** Toggle block visibility. `flex` is re-applied for flex containers when shown. */
function setShown(el: HTMLElement, show: boolean, flex = false): void {
  el.classList.toggle('hidden', !show)
  if (flex) {
    el.classList.toggle('flex', show)
  }
}

function fmtDuration(sec?: number): string {
  if (!sec || sec <= 0) {
    return ''
  }
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function renderAll(): Promise<void> {
  const [apiKey, secret, username, sk, threshold, queue, status, pending, authErrorText] =
    await Promise.all([
      apiKeyItem.getValue(),
      apiSecretItem.getValue(),
      usernameItem.getValue(),
      sessionKeyItem.getValue(),
      thresholdItem.getValue(),
      queueItem.getValue(),
      statusItem.getValue(),
      pendingAuthItem.getValue(),
      authErrorItem.getValue(),
    ])
  // Diagnostics row exists in dev builds only.
  let dbg: DebugInfo | null = null
  if (import.meta.env.DEV) {
    dbg = await debugItem.getValue()
  }

  const apiKeyInput = $<HTMLInputElement>('apiKey')
  const apiSecretInput = $<HTMLInputElement>('apiSecret')
  const thresholdInput = $<HTMLInputElement>('threshold')
  // Never clobber text the user is typing: storage changes arrive
  // from elsewhere (threshold slider, queue updates, dev diagnostics).
  if (document.activeElement !== apiKeyInput) {
    apiKeyInput.value = apiKey ?? ''
  }
  if (document.activeElement !== apiSecretInput) {
    apiSecretInput.value = secret ?? ''
  }
  thresholdInput.value = String(threshold ?? 50)
  $('thresholdVal').textContent = String(threshold ?? 50)

  const loggedIn = Boolean(sk && username)
  const waiting = !loggedIn && pending != null
  if (loggedIn) {
    $('whoami').textContent = `Подключено как ${username}`
  } else {
    $('whoami').textContent = 'Не подключено'
  }
  // Key fields only make sense before login; logout only after login.
  setShown($('keyFields'), !loggedIn && !waiting, true)
  setShown($('authWaiting'), waiting, true)
  setShown($('btnLogout'), loggedIn)
  if (loggedIn) {
    $('authError').textContent = ''
  } else {
    $('authError').textContent = authErrorText ?? ''
  }

  const dbgParts: string[] = []
  if (dbg && dbg.artist) {
    dbgParts.push(`${dbg.artist} — ${dbg.track} · ${dbg.pct}%`)
  }
  if (dbg?.lastResult) {
    dbgParts.push(dbg.lastResult)
  }
  if (dbgParts.length > 0) {
    $('dbgLine').textContent = dbgParts.join(' · ')
  } else {
    $('dbgLine').textContent = 'нет данных — включите трек'
  }

  const badge = $('status')
  const count = queue?.length ?? 0
  $('queueCount').textContent = String(count)
  setShown($('queueSection'), count > 0)
  badge.className = 'badge'
  if (loggedIn && (status === 'ok' || status === 'idle') && count === 0) {
    badge.classList.add('badge-success')
    badge.textContent = 'OK'
  } else if (!loggedIn && waiting) {
    badge.classList.add('badge-info')
    badge.textContent = 'Вход…'
  } else if (status === 'needAuth' || (!loggedIn && count > 0)) {
    badge.classList.add('badge-warning')
    badge.textContent = 'Нужен вход'
  } else if (count > 0 || status === 'offline') {
    badge.classList.add('badge-warning')
    badge.textContent = `Офлайн · ${count}`
  } else {
    badge.classList.add('badge-ghost')
    if (loggedIn) {
      badge.textContent = 'OK'
    } else {
      badge.textContent = 'Нет входа'
    }
  }

  const list = $('queue')
  list.innerHTML = ''
  if (count === 0) {
    const li = document.createElement('li')
    li.className = 'px-3 py-2 opacity-60'
    li.textContent = 'Очередь пуста'
    list.appendChild(li)
  } else {
    for (const t of [...(queue ?? [])].reverse()) {
      const li = document.createElement('li')
      li.className = 'px-3 py-1.5'
      const dur = fmtDuration(t.duration)
      let label = `${t.artist} — ${t.track}`
      if (dur) {
        label += ` · ${dur}`
      }
      label += ` · ${fmtTime(t.timestamp)}`
      li.textContent = label
      list.appendChild(li)
    }
  }
}

async function wakeBackground(): Promise<void> {
  await browser.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }).catch(() => {})
}

function init(): void {
  // Diagnostics row exists in dev builds only.
  setShown($('dbgRow'), import.meta.env.DEV)
  const apiKeyEl = $('apiKey') as HTMLInputElement
  const apiSecretEl = $('apiSecret') as HTMLInputElement
  const thresholdEl = $('threshold') as HTMLInputElement

  apiKeyEl.addEventListener('change', () => {
    void apiKeyItem.setValue(apiKeyEl.value.trim())
  })
  apiSecretEl.addEventListener('change', () => {
    void apiSecretItem.setValue(apiSecretEl.value.trim())
  })

  // Applies immediately, no submit button.
  thresholdEl.addEventListener('input', () => {
    const v = Number(thresholdEl.value)
    $('thresholdVal').textContent = String(v)
    void thresholdItem.setValue(v).then(() => wakeBackground())
  })

  $('btnLogin').addEventListener('click', async () => {
    const apiKey = apiKeyEl.value.trim()
    const secret = apiSecretEl.value.trim()
    if (!apiKey || !secret) {
      await authErrorItem.setValue('Введите API key и Shared secret (last.fm/api/account).')
      return
    }
    await apiKeyItem.setValue(apiKey)
    await apiSecretItem.setValue(secret)
    // Background issues the token, opens last.fm and polls for approval.
    await browser.runtime.sendMessage({ type: 'AUTH_START' }).catch(() => {})
    await renderAll()
  })

  $('btnCheckNow').addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'AUTH_CHECK_NOW' }).catch(() => {})
    await renderAll()
  })

  $('btnCancel').addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'AUTH_CANCEL' }).catch(() => {})
    await renderAll()
  })

  $('btnLogout').addEventListener('click', async () => {
    await sessionKeyItem.setValue('')
    await usernameItem.setValue('')
    await browser.runtime.sendMessage({ type: 'AUTH_CANCEL' }).catch(() => {})
    await renderAll()
  })

  $('btnSync').addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement
    btn.disabled = true
    try {
      await browser.runtime.sendMessage({ type: 'SYNC_NOW' }).catch(() => {})
      // Give background a moment to flush, then re-render.
      setTimeout(() => {
        void renderAll()
      }, 800)
    } finally {
      btn.disabled = false
    }
  })

  $('btnClear').addEventListener('click', async () => {
    if (!window.confirm('Очистить очередь из нескроббленных треков?')) {
      return
    }
    await browser.runtime.sendMessage({ type: 'CLEAR_QUEUE' }).catch(() => {})
    await renderAll()
  })

  browser.storage.onChanged.addListener(() => {
    void renderAll()
  })

  // Fast path: user approved on last.fm and reopened the popup — complete immediately.
  void pendingAuthItem.getValue().then((pending) => {
    if (pending) {
      void browser.runtime.sendMessage({ type: 'AUTH_CHECK_NOW' }).catch(() => {})
    }
  })
  // Live update while the popup is open during pending auth.
  setInterval(() => {
    void pendingAuthItem.getValue().then((pending) => {
      if (pending) {
        void browser.runtime.sendMessage({ type: 'AUTH_CHECK_NOW' }).catch(() => {})
      }
    })
  }, 3000)

  void renderAll()
}

document.addEventListener('DOMContentLoaded', init)
