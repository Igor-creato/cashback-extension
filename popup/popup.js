/**
 * Popup script для браузерного расширения кэшбэк-сервиса.
 *
 * Управляет отображением:
 * - Экрана онбординга (если consent ещё не получен)
 * - Экрана авторизации
 * - Баланса пользователя
 * - Блока кэшбэка (3 состояния: idle / active / expired)
 * - Списка последних транзакций
 *
 * Состояния competing/реактивации удалены: расширение не детектирует
 * чужую атрибуцию и не предлагает перебить её через нашу партнёрку.
 */

document.addEventListener('DOMContentLoaded', init);

// ─── Элементы DOM ───

const $ = (selector) => document.querySelector(selector);

const els = {
    loading:              $('#loading'),
    screenConsent:        $('#screen-consent'),
    btnOpenOnboarding:    $('#btn-open-onboarding'),
    consentPolicyLink:    $('#consent-policy-link'),
    footerPolicyLink:     $('#footer-policy-link'),
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
    // expired state
    cashbackExpired:      $('#cashback-expired'),
    expiredStoreName:     $('#expired-store-name'),
    btnReactivateExpired: $('#btn-reactivate-expired'),
    // none state
    cashbackNone:         $('#cashback-none'),
    linkStores:           $('#link-stores'),
    // promocodes
    promocodesSection:    $('#promocodes-section'),
    promocodesList:       $('#promocodes-list'),
    // other
    transactionsSection:  $('#transactions-section'),
    transactionsList:     $('#transactions-list'),
    btnRefresh:           $('#btn-refresh'),
};

let timerInterval = null;

// ─── Инициализация ───

async function init() {
    // Ссылки на политику обработки данных — экран consent + футер
    els.consentPolicyLink.href = CASHBACK_CONFIG.PRIVACY_POLICY_URL;
    els.footerPolicyLink.href  = CASHBACK_CONFIG.PRIVACY_POLICY_URL;

    // Кнопка «Открыть онбординг» на экране consent
    els.btnOpenOnboarding.addEventListener('click', async () => {
        await sendMessage({ type: 'OPEN_ONBOARDING' });
        window.close();
    });

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
    els.btnReactivateExpired.addEventListener('click', () => handleActivate(els.btnReactivateExpired));

    // Кнопка вывода кэшбэка
    els.btnWithdraw.addEventListener('click', () => {
        chrome.tabs.create({ url: CASHBACK_CONFIG.WITHDRAWAL_URL });
    });

    // Кнопка обновления магазинов
    els.btnRefresh.addEventListener('click', handleRefresh);

    // Имя пользователя → личный кабинет.
    // chrome.tabs.create открывает в новой вкладке и закрывает popup —
    // надёжнее target="_blank" для extension popup. isValidRedirectUrl
    // отсекает javascript:/data: на случай если account_url из /me был
    // подменён скомпрометированным сервером (defense-in-depth).
    els.userName.addEventListener('click', (e) => {
        const href = els.userName.getAttribute('href');
        if (!href || href === '#' || !isValidRedirectUrl(href)) return;
        e.preventDefault();
        chrome.tabs.create({ url: href });
    });

    // Сначала — consent gate. До прохождения онбординга функциональность
    // активации недоступна, и нет смысла дёргать API.
    let consentResult;
    try {
        consentResult = await sendMessage({ type: 'CHECK_CONSENT' });
    } catch {
        consentResult = { consent: false };
    }
    if (!consentResult || !consentResult.consent) {
        showScreen('consent');
        return;
    }

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

        // Если пользователь стоит на распознанном магазине — пытаемся
        // показать его активные промокоды вместо последних покупок.
        // Fallback на транзакции при пустом списке / ошибке сети.
        const shownPromocodes = await tryRenderPromocodesForStore(storeInfo);
        if (!shownPromocodes) {
            renderTransactions(transactions);
        }
    } catch {
        showScreen('auth');
    }
}

// ─── Экраны ───

function showScreen(screen) {
    els.loading.classList.add('hidden');
    els.screenConsent.classList.add('hidden');
    els.screenAuth.classList.add('hidden');
    els.screenMain.classList.add('hidden');

    switch (screen) {
        case 'consent':
            els.screenConsent.classList.remove('hidden');
            break;
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
    // account_url приходит из /me (см. Cashback_REST_API::get_me). Fallback
    // на конфиг — для старых версий плагина без этого поля.
    const accountUrl = profile.account_url || CASHBACK_CONFIG.LOGIN_URL;
    els.userName.href = accountUrl;

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
 * Три состояния: idle / active / expired. Нет магазина → none.
 */
function renderCashbackSection(storeInfo) {
    els.cashbackSection.classList.remove('hidden');

    // Скрываем все состояния
    els.cashbackAvailable.classList.add('hidden');
    els.cashbackActivated.classList.add('hidden');
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

        case 'expired':
            // TTL истёк — серая карточка. Кнопка ведёт на single product page
            // на сайте; активацию запускает уже она (плагин), а не popup.
            els.cashbackExpired.classList.remove('hidden');
            els.expiredStoreName.textContent = store.store_name || store.domain;
            els.btnReactivateExpired.dataset.permalink = store.permalink || '';
            break;

        default:
            // idle: кэшбэк доступен, но не активирован — красная карточка.
            // Кнопка ведёт на single product page магазина; popup сам активацию
            // не запускает (это делает страница товара после клика пользователя
            // на её собственный CTA).
            els.cashbackAvailable.classList.remove('hidden');
            els.storeName.textContent   = store.store_name || store.domain;
            els.cashbackValue.textContent =
                (store.cashback_label || 'Кэшбэк') + ' ' +
                (store.cashback_value || '');
            els.btnActivate.dataset.permalink = store.permalink || '';
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
 *   #btn-activate           (idle state)
 *   #btn-reactivate-expired (expired state)
 *
 * Popup сам активацию не запускает — он открывает single product page
 * магазина на нашем сайте в новой вкладке; саму активацию выполняет уже
 * страница товара (тот же CTA, что доступен в каталоге). Так логика не
 * дублируется между расширением и плагином, и пользователь видит полный
 * контекст товара (правила, промокоды, тарифы) перед кликом.
 */
function handleActivate(btn) {
    const permalink = btn.dataset.permalink;
    if (!permalink || !isValidRedirectUrl(permalink)) return;
    chrome.tabs.create({ url: permalink });
    window.close();
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

// ─── Промокоды текущего магазина ───

/**
 * Если на текущей вкладке распознан партнёрский магазин (storeInfo.store),
 * пытается загрузить его активные промокоды и отрисовать секцию вместо
 * «Последних покупок».
 *
 * @returns {Promise<boolean>} true — промокоды найдены и отрисованы,
 *                              false — нет магазина / промокодов / ошибка
 *                              (caller рендерит транзакции как fallback).
 */
async function tryRenderPromocodesForStore(storeInfo) {
    if (!storeInfo || !storeInfo.store || !storeInfo.store.product_id) {
        showTransactionsSection();
        return false;
    }
    try {
        const data = await CashbackAPI.fetchPromocodes(storeInfo.store.product_id);
        if (data && Array.isArray(data.items) && data.items.length > 0) {
            renderPromocodes(data.items, storeInfo.store);
            showPromocodesSection();
            return true;
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[CB] fetchPromocodes failed:', err && err.message);
    }
    showTransactionsSection();
    return false;
}

function showPromocodesSection() {
    els.promocodesSection.classList.remove('hidden');
    els.transactionsSection.classList.add('hidden');
}

function showTransactionsSection() {
    els.promocodesSection.classList.add('hidden');
    els.transactionsSection.classList.remove('hidden');
}

function renderPromocodes(items, store) {
    // «Перейти» на промокоде ведёт на single product page магазина с активной
    // вкладкой промокодов (как иконка промокода в каталоге плагина — там та же
    // конвенция `?cb_tab=coupons`, обрабатываемая cashback-coupons-tab.js).
    // Один URL на все промокоды одного магазина — это намеренно: страница уже
    // показывает все активные коды.
    const storePermalink = (store && store.permalink) || '';
    const gotoUrl = storePermalink
        ? `${storePermalink}${storePermalink.includes('?') ? '&' : '?'}cb_tab=coupons`
        : '#';
    const gotoAttr = escapeAttr(gotoUrl);

    els.promocodesList.innerHTML = items
        .map((promo) => {
            const name        = escapeHtml(promo.name || '');
            const code        = promo.promocode || '';
            const hasCode     = code !== '';
            const codeEsc     = escapeHtml(code);
            const codeAttr    = escapeAttr(code);
            const exclusive   = promo.is_exclusive
                ? '<span class="promo-card__exclusive">Эксклюзив</span>'
                : '';
            const discount    = promo.discount
                ? `<div class="promo-card__discount">${escapeHtml(String(promo.discount))}</div>`
                : '';
            const dateEnd     = promo.date_end
                ? `<div class="promo-card__date">до ${escapeHtml(formatPromoDate(promo.date_end))}</div>`
                : '';
            const codeRow     = hasCode
                ? `<div class="promo-card__code-row">
                       <code class="promo-card__code">${codeEsc}</code>
                       <button type="button" class="promo-card__copy" data-clipboard="${codeAttr}" aria-label="Скопировать промокод">Скопировать</button>
                   </div>`
                : '';

            return `
                <article class="promo-card" data-promo-id="${escapeAttr(String(promo.id))}">
                    ${exclusive}
                    ${discount}
                    <div class="promo-card__name">${name}</div>
                    ${codeRow}
                    ${dateEnd}
                    <a class="promo-card__goto"
                       href="${gotoAttr}"
                       target="_blank"
                       rel="noopener nofollow"
                       data-action="goto">Активировать на сайте</a>
                </article>
            `;
        })
        .join('');

    bindPromoCopyHandlers();
    bindPromoGotoHandlers();
}

function bindPromoCopyHandlers() {
    els.promocodesList.querySelectorAll('.promo-card__copy').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const code = btn.dataset.clipboard || '';
            if (!code) return;
            try {
                await navigator.clipboard.writeText(code);
                const original = btn.textContent;
                btn.classList.add('copied');
                btn.textContent = 'Скопировано';
                setTimeout(() => {
                    btn.classList.remove('copied');
                    btn.textContent = original;
                }, 1500);
            } catch {
                // clipboard API недоступен — игнорируем, пользователь может
                // выделить код руками.
            }
        });
    });
}

function bindPromoGotoHandlers() {
    // chrome.tabs.create открывает в новой вкладке и закрывает popup
    // надёжнее, чем target="_blank" — для extension popup поведение
    // последнего нестабильно. isValidRedirectUrl блокирует javascript:/data:
    // на случай мусора в permalink из /stores.
    els.promocodesList.querySelectorAll('.promo-card__goto').forEach((a) => {
        a.addEventListener('click', (e) => {
            const href = a.getAttribute('href');
            if (!href || href === '#' || !isValidRedirectUrl(href)) return;
            e.preventDefault();
            chrome.tabs.create({ url: href });
        });
    });
}

function formatPromoDate(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        if (Number.isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('ru-RU', {
            day:   '2-digit',
            month: '2-digit',
            year:  'numeric',
        });
    } catch {
        return dateStr;
    }
}

function escapeAttr(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    })[ch]);
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
