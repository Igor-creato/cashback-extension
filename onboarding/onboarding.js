/**
 * Onboarding-страница расширения.
 *
 * Открывается автоматически при первой установке (chrome.runtime.onInstalled).
 * Записывает флаг consent_at в chrome.storage.local — service worker и popup
 * проверяют его перед любыми действиями, связанными с активацией кэшбэка.
 *
 * Если пользователь отказался — флаг не записывается, функции активации
 * остаются недоступными. Открыть онбординг повторно можно из попапа.
 */

document.addEventListener('DOMContentLoaded', () => {
  const policyLink   = document.getElementById('policy-link');
  const btnAccept    = document.getElementById('btn-accept');
  const btnDecline   = document.getElementById('btn-decline');
  const declinedHint = document.getElementById('declined-hint');

  if (policyLink && typeof CASHBACK_CONFIG !== 'undefined') {
    policyLink.href = CASHBACK_CONFIG.PRIVACY_POLICY_URL;
  }

  // Если consent уже есть — закрываем вкладку сразу, чтобы повторное открытие
  // онбординга (через попап) не повисло без причины.
  chrome.storage.local
    .get('consent_at')
    .then((data) => {
      if (data && data.consent_at) {
        btnAccept.textContent = 'Закрыть';
      }
    })
    .catch(() => {});

  btnAccept.addEventListener('click', async () => {
    btnAccept.disabled = true;
    try {
      await chrome.storage.local.set({ consent_at: Date.now() });
    } catch {
      // Если запись не удалась — кнопка останется заблокированной
      btnAccept.disabled = false;
      btnAccept.textContent = 'Ошибка. Попробуйте снова';
      return;
    }
    closeCurrentTab();
  });

  btnDecline.addEventListener('click', () => {
    if (declinedHint) {
      declinedHint.classList.remove('hidden');
    }
  });
});

async function closeCurrentTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab && tab.id !== undefined) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    // Не удалось закрыть программно — попробуем через window.close()
  }
  try {
    window.close();
  } catch {
    // последний fallback — оставим вкладку открытой
  }
}
