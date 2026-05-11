/**
 * Popup script для браузерного расширения кэшбэк-сервиса.
 *
 * Управляет отображением:
 * - Экрана авторизации
 * - Баланса пользователя
 * - Блока кэшбэка (4 состояния: idle / active / competing / expired)
 * - Списка последних транзакций
 */

document.addEventListener('DOMContentLoaded', init);

// ─── Элементы DOM ───

const $ = (selector) => document.querySelector(selector);

const els = {
    loading:              $('#loading'),
    screenAuth:           $('#screen-auth'),
    screenMain:           $('#screen-main'),
    btnLogin:             $('#btn-login'),
    userName:             $('#user-name'),
    balanceAvailable:     $('#balance-available'),
    balancePending:       $('#balance-pending'),
    balancePaid:          $('#balance-paid'),
    btnWithdraw:          $('#btn-withdraw'),
    cashbackSection:      $('#cashback-section'),
    // idle state
    cashbackAvailable:    $('#cashback-available'),
    storeName:            $('#store-name'),
    cashbackValue:        $('#cashback-value'),
    btnActivate:          $('#btn-activate'),
    // active state
    cashbackActivated:    $('#cashback-activated'),
    timerValue:           $('#timer-value'),
    // competing state
    cashbackCompeting:    $('#cashback-competing'),
    competingStoreName:   $('#competing-store-name'),
    btnReactivate:        $('#btn-reactivate'),
    // expired state
    cashbackExpired:      $('#cashback-expired'),
    expiredStoreName:     $('#expired-store-name'),
    btnReactivateExpired: $('#btn-reactivate-expired'),
    // none state
    cashbackNone:         $('#cashback-none'),
    linkStores:           $('#link-stores'),
    // other
    transactionsList:     $('#transactions-list'),
    btnRefresh:           $('#btn-refresh'),
};

let timerInterval = null;

// ─── Инициализация ───

async function init() {
    // Кнопка входа
    els.btnLogin.addEventListener('click', () => {
        chrome.tabs.create({ url: CASHBACK_CONFIG.LOGIN_URL });
    });

    // Ссылка на магазины
    els.linkStores.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: CASHBACK_CONFIG.STORES_URL });
    });

    // Кнопки активации
    els.btnActivate.addEventListener('click', () => handleActivate(els.btnActivate));
    els.btnReactivate.addEventListener('click', () => handleActivate(els.btnReactivate));
    els.btnReactivateExpired.addEventListener('click', () => handleActivate(els.btnReactivateExpired));

    // Кнопка вывода кэшбэка
    els.btnWithdraw.addEventListener('click', () => {
        chrome.tabs.create({ url: CASHBACK_CONFIG.WITHDRAWAL_URL });
    });

    // Кнопка обновления магазинов
    els.btnRefresh.addEventListener('click', handleRefresh);

    // Проверка авторизации
    try {
        const authResult = await sendMessage({ type: 'CHECK_AUTH' });

        if (!authResult.authenticated) {
            showScreen('auth');
            return;
        }

        // Авторизован — показываем основной экран
        showScreen('main');
        renderProfile(authResult.profile);

        // Загружаем данные параллельно
        const [storeInfo, transactions] = await Promise.all([
            getCurrentTabStoreInfo(),
            sendMessage({ type: 'GET_TRANSACTIONS', page: 1, perPage: 5 }),
        ]);

        renderCashbackSection(storeInfo);
        renderTransactions(transactions);
    } catch {
        showScreen('auth');
    }
}

// ─── Экраны ───

function showScreen(screen) {
    els.loading.classList.add('hidden');
    els.screenAuth.classList.add('hidden');
    els.screenMain.classList.add('hidden');

    switch (screen) {
        case 'auth':
            els.screenAuth.classList.remove('hidden');
            break;
        case 'main':
            els.screenMain.classList.remove('hidden');
            break;
    }
}

// ─── Профиль и баланс ───

function renderProfile(profile) {
    els.userName.textContent = profile.display_name;
    els.balanceAvailable.textContent = formatMoney(profile.balance.available);
    els.balancePending.textContent = formatMoney(profile.balance.pending);
    els.balancePaid.textContent = formatMoney(profile.balance.paid);

    // Показываем кнопку вывода если доступный баланс > 0
    if (parseFloat(profile.balance.available) > 0) {
        els.btnWithdraw.classList.remove('hidden');
    } else {
        els.btnWithdraw.classList.add('hidden');
    }
}

// ─── Кэшбэк-секция ───

async function getCurrentTabStoreInfo() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return null;

    try {
        const domain = new URL(tab.url).hostname.replace(/^www\./i, '');
        return sendMessage({ type: 'GET_STORE_INFO', domain });
    } catch {
        return null;
    }
}

/**
 * Рендер блока кэшбэка для текущего сайта.
 * Четыре состояния: idle / active / competing / expired.
 * Нет магазина → none.
 */
function renderCashbackSection(storeInfo) {
    els.cashbackSection.classList.remove('hidden');

    // Скрываем все состояния
    els.cashbackAvailable.classList.add('hidden');
    els.cashbackActivated.classList.add('hidden');
    els.cashbackCompeting.classList.add('hidden');
    els.cashbackExpired.classList.add('hidden');
    els.cashbackNone.classList.add('hidden');

    if (!storeInfo || !storeInfo.store) {
        // Нет кэшбэка на этом сайте
        els.cashbackNone.classList.remove('hidden');
        return;
    }

    // Определяем состояние: из нового поля state или из legacy-поля activated
    const state = storeInfo.state ||
        (storeInfo.activated ? 'active' : 'idle');

    const store = storeInfo.store;

    switch (state) {
        case 'active':
            // Кэшбэк активирован — зелёная иконка, таймер
            els.cashbackActivated.classList.remove('hidden');
            startTimer(storeInfo.activation);
            break;

        case 'competing':
            // Чужой сайт перехватил активацию — оранжевая карточка
            els.cashbackCompeting.classList.remove('hidden');
            els.competingStoreName.textContent = store.store_name || store.domain;
            // Устанавливаем данные для повторной активации
            els.btnReactivate.dataset.productId = store.product_id;
            els.btnReactivate.dataset.domain    = store.domain;
            break;

        case 'expired':
            // TTL истёк — серая карточка
            els.cashbackExpired.classList.remove('hidden');
            els.expiredStoreName.textContent = store.store_name || store.domain;
            els.btnReactivateExpired.dataset.productId = store.product_id;
            els.btnReactivateExpired.dataset.domain    = store.domain;
            break;

        default:
            // idle: кэшбэк доступен, но не активирован — красная карточка
            els.cashbackAvailable.classList.remove('hidden');
            els.storeName.textContent   = store.store_name || store.domain;
            els.cashbackValue.textContent =
                (store.cashback_label || 'Кэшбэк') + ' ' +
                (store.cashback_value || '');
            els.btnActivate.dataset.productId = store.product_id;
            els.btnActivate.dataset.domain    = store.domain;
            break;
    }
}

// ─── Обновление списка магазинов ───

async function handleRefresh() {
    const btn = els.btnRefresh;
    if (btn.classList.contains('spinning')) return;

    btn.classList.add('spinning');

    try {
        await sendMessage({ type: 'REFRESH_STORES' });

        // Перезагрузить информацию о текущем магазине
        const storeInfo = await getCurrentTabStoreInfo();
        renderCashbackSection(storeInfo);
    } catch {
        // Ошибка обновления — игнорируем
    } finally {
        btn.classList.remove('spinning');
    }
}

// ─── Активация / повторная активация кэшбэка ───

/**
 * Универсальный обработчик для кнопок:
 *   #btn-activate        (idle state)
 *   #btn-reactivate      (competing state)
 *   #btn-reactivate-expired (expired state)
 *
 * Все три кнопки хранят productId и domain в data-атрибутах.
 */
async function handleActivate(btn) {
    const productId = parseInt(btn.dataset.productId, 10);
    const domain    = btn.dataset.domain;

    if (!productId || btn.disabled) return;

    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = 'Активация...';

    try {
        const result = await sendMessage({
            type: 'ACTIVATE',
            productId,
            domain,
        });

        if (result.error) {
            throw new Error(result.error);
        }

        // Redirect через activation page (interstitial) для:
        // 1. CPA-сеть видит корректный Referer
        // 2. Content script bridge подтверждает активацию расширению
        // Fallback: redirect_url напрямую если activation_page_url нет
        const redirectTo = (result.activation_page_url && isValidRedirectUrl(result.activation_page_url))
            ? result.activation_page_url
            : result.redirect_url;

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && redirectTo && isValidRedirectUrl(redirectTo)) {
            await chrome.tabs.update(tab.id, { url: redirectTo });
        }

        // Переключаем на состояние "активирован" независимо от исходного состояния
        els.cashbackAvailable.classList.add('hidden');
        els.cashbackCompeting.classList.add('hidden');
        els.cashbackExpired.classList.add('hidden');
        els.cashbackActivated.classList.remove('hidden');

        startTimer({
            remaining_minutes: 30,
            activated_at:      new Date().toISOString(),
        });
    } catch {
        btn.textContent = 'Ошибка. Попробуйте снова';
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
    }
}

// ─── Таймер активации ───

function startTimer(activation) {
    if (timerInterval) {
        clearInterval(timerInterval);
    }

    const updateTimer = () => {
        let remainingMs;

        if (activation.remaining_minutes !== undefined) {
            // Пересчитываем на основе timestamp
            const activatedAt = activation.activated_at
                ? new Date(activation.activated_at).getTime()
                : Date.now();
            const elapsed = Date.now() - activatedAt;
            remainingMs = CASHBACK_CONFIG.ACTIVATION_TTL - elapsed;
        } else if (activation.expires_at) {
            remainingMs = new Date(activation.expires_at).getTime() - Date.now();
        } else {
            remainingMs = CASHBACK_CONFIG.ACTIVATION_TTL;
        }

        if (remainingMs <= 0) {
            els.timerValue.textContent = 'Истёк';
            clearInterval(timerInterval);
            // Переключаем на состояние "expired"
            setTimeout(() => location.reload(), 1000);
            return;
        }

        const minutes = Math.floor(remainingMs / 60000);
        const seconds = Math.floor((remainingMs % 60000) / 1000);
        els.timerValue.textContent = `${minutes} мин ${seconds.toString().padStart(2, '0')} сек`;
    };

    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
}

// ─── Транзакции ───

function renderTransactions(data) {
    if (!data || !data.items || data.items.length === 0) {
        els.transactionsList.innerHTML =
            '<div class="transactions-empty">Нет транзакций</div>';
        return;
    }

    els.transactionsList.innerHTML = data.items
        .map((item) => {
            const statusClass = getStatusClass(item.order_status);
            const statusLabel = getStatusLabel(item.order_status);
            const date   = formatDate(item.action_date || item.created_at);
            const amount = formatMoney(item.cashback);

            return `
                <div class="transaction-item">
                    <div class="transaction-left">
                        <span class="transaction-name" title="${escapeHtml(item.offer_name || item.partner || '')}">${escapeHtml(item.offer_name || item.partner || 'Покупка')}</span>
                        <span class="transaction-date">${date}</span>
                    </div>
                    <div class="transaction-right">
                        <span class="transaction-amount positive">+${amount}</span>
                        <span class="transaction-status ${statusClass}">${statusLabel}</span>
                    </div>
                </div>
            `;
        })
        .join('');
}

// ─── Утилиты ───

function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
}

function formatMoney(amount) {
    const num = parseFloat(amount) || 0;
    return num.toLocaleString('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }) + ' ' + CASHBACK_CONFIG.CURRENCY_SYMBOL;
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
        const date = new Date(dateStr);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleDateString('ru-RU', {
            day:   '2-digit',
            month: '2-digit',
            year:  'numeric',
        });
    } catch {
        return '';
    }
}

function getStatusClass(status) {
    const map = {
        waiting:   'status-waiting',
        completed: 'status-completed',
        balance:   'status-balance',
        declined:  'status-declined',
        hold:      'status-hold',
    };
    return map[status] || 'status-waiting';
}

function getStatusLabel(status) {
    const map = {
        waiting:   'Ожидание',
        completed: 'Подтверждён',
        balance:   'Зачислен',
        declined:  'Отклонён',
        hold:      'Проверка',
    };
    return map[status] || 'Неизвестно';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function isValidRedirectUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}
