/**
 * Service Worker для браузерного расширения кэшбэк-сервиса.
 *
 * Управляет:
 * - Определением магазинов-партнёров по домену текущей вкладки
 * - Состоянием иконки (серая/красная/зелёная)
 * - Кешем списка магазинов
 * - Сообщениями от popup и content scripts
 */

// Импорт конфигурации и API (через importScripts для service worker)
importScripts('../utils/config.js', '../utils/api.js');

// ─── Константы ───

const ICON_STATES = {
    GRAY:  'gray',
    RED:   'red',
    GREEN: 'green',
};

/**
 * Четыре состояния кэшбэка для домена:
 *   idle      — нет активации (пользователь не активировал)
 *   active    — наша активация действует (зелёный значок)
 *   competing — после нашей активации сработала чужая партнёрская ссылка
 *   expired   — TTL истёк (запись сохраняется для UX — "Время истекло")
 */
const CASHBACK_STATE = {
    IDLE:      'idle',
    ACTIVE:    'active',
    COMPETING: 'competing',
    EXPIRED:   'expired',
};

const ALARM_REFRESH_STORES    = 'refresh-stores';
const ALARM_CLEANUP_ACTIVATIONS = 'cleanup-activations';
const CURRENT_USER_KEY        = 'current_user_id';

// ─── Навигационная история вкладок (для детекции competing) ───
//
// webNavigation API отслеживает ВСЕ навигации включая серверные редиректы,
// даже когда document.referrer пуст (Referrer-Policy: no-referrer, rel="noreferrer").
// Это главный механизм обнаружения перебития кэшбэка чужим сервисом.

const TAB_NAV_HISTORY         = new Map(); // tabId → [{domain, timestamp}]
const NAV_HISTORY_WINDOW      = 60 * 1000; // 60 секунд — окно для redirect-цепочки
const NAV_HISTORY_MAX_ENTRIES = 30;

/**
 * Домены конкурирующих кэшбэк-сервисов и affiliate-сетей.
 * Используется и в service-worker (webNavigation), и в content.js (referrer fallback).
 */
const COMPETING_DOMAINS = [
    // Российские кэшбэк-сервисы
    'letyshops.com', 'megabonus.com', 'kopikot.ru',
    'smarty.sale',   'cashback.ru',   'giftd.tech',
    'skidka.ru',     'backit.me',     'epn.bz',
    'cashbackoff.ru','switchback.ru', 'promokodus.com',
    // Affiliate-сети (чужие ссылки)
    'admitad.com',  'cityads.ru',  'actionpay.ru',
    'leads.su',     'cpa.ru',      'where.ru',
    // Глобальные кэшбэк и affiliate
    'honey.com',          'joinhoney.com',
    'awin.com',           'awinmid.com',
    'tradedoubler.com',   'rakuten.com',
    'linksynergy.com',    'commissionjunction.com',
    'cj.com',             'shareasale.com',
    'impact.com',         'partnerize.com',
];

/**
 * Affiliate-параметры URL, которые идентифицируют конкретного партнёра/клик.
 * При активации сохраняем значения наших параметров. Если при следующем визите
 * те же параметры имеют ДРУГИЕ значения — кэшбэк перебит чужим сервисом.
 * Прямые заходы (без affiliate-параметров) НЕ считаются competing.
 */
const AFFILIATE_TRACKING_PARAMS = [
    'tagtag_uid',                              // Admitad
    'admitad_uid',                             // Admitad
    'subid', 'subid1', 'subid2', 'subid3',    // Общие CPA sub-ID
    'click_id', 'clickid',                     // Общий click tracking
    'aff_id', 'aff_sub', 'aff_sub2',          // Общие affiliate
    'awc',                                     // AWIN
    'tduid',                                   // TradeDoubler
    'irclickid',                               // Impact Radius
    'cjevent',                                 // Commission Junction
    'wcid',                                    // WebGains
    'ranMID', 'ranEAID', 'ranSiteID',         // Rakuten
    'sscid',                                   // ShareASale
    'partnerize_clickid',                      // Partnerize
];

// ─── Кеширование текущего пользователя ───

async function getCachedUserId() {
    const data = await chrome.storage.session.get(CURRENT_USER_KEY);
    return data[CURRENT_USER_KEY] || null;
}

async function setCachedUserId(userId) {
    if (!userId) return;
    // Всегда храним как строку — API возвращает число, а активации хранят строку.
    // Несоответствие типов приводит к "123" !== 123 → ложному промаху кеша.
    const normalizedId = String(userId);
    const prev = await getCachedUserId();
    await chrome.storage.session.set({ [CURRENT_USER_KEY]: normalizedId });
    // При смене пользователя — очистить все активации предыдущего
    if (prev && prev !== normalizedId) {
        await clearAllActivations();
    }
}

async function clearCachedUserId() {
    await chrome.storage.session.remove(CURRENT_USER_KEY);
}

async function clearAllActivations() {
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith('activation_'));
    if (keys.length > 0) {
        await chrome.storage.session.remove(keys);
    }
}

// ─── Инициализация ───

chrome.runtime.onInstalled.addListener(async () => {
    // Загрузить список магазинов при установке
    try {
        await CashbackAPI.fetchStores(true);
    } catch (e) {
        console.warn('[Cashback] Failed to load stores on install:', e.message);
    }

    // Периодическое обновление списка магазинов (каждые 15 минут — как резервный механизм,
    // основной TTL кеша — 10 минут, данные обновляются при каждом визите)
    chrome.alarms.create(ALARM_REFRESH_STORES, { periodInMinutes: 15 });

    // Очистка устаревших активаций (каждые 5 минут)
    chrome.alarms.create(ALARM_CLEANUP_ACTIVATIONS, { periodInMinutes: 5 });
});

// ─── Alarms ───

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_REFRESH_STORES) {
        try {
            await CashbackAPI.fetchStores(true);
        } catch (e) {
            console.warn('[Cashback] Failed to refresh stores:', e.message);
        }
    }

    if (alarm.name === ALARM_CLEANUP_ACTIVATIONS) {
        await cleanupExpiredActivations();
    }

    // Alarm при истечении TTL конкретного домена → иконка красная
    if (alarm.name.startsWith('expire_')) {
        const domain = alarm.name.slice('expire_'.length);
        await updateActivationState(domain, CASHBACK_STATE.EXPIRED);
        await updateIconForAllTabsWithDomain(domain);
    }
});

// ─── Слушатели вкладок ───

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // Ловим страницу активации при начале загрузки (до того как JS-redirect уведёт дальше).
    // changeInfo.url появляется при навигации — не ждём 'complete'.
    if (changeInfo.url && isActivationPageUrl(changeInfo.url)) {
        await handleActivationPageNavigation(changeInfo.url);
    }

    if (changeInfo.status === 'complete' && tab.url) {
        // Повторная проверка на случай если loading-событие было пропущено
        if (isActivationPageUrl(tab.url)) {
            await handleActivationPageNavigation(tab.url);
        }
        // Читаем cookie cb_activation, установленный PHP при ?cashback_click=.
        // Работает как надёжный fallback для всех сценариев потери активации.
        await syncActivationFromCookie();
        await updateIconForTab(tabId, tab.url);
    }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab.url) {
            await updateIconForTab(activeInfo.tabId, tab.url);
        }
    } catch (e) {
        // Вкладка может быть уже закрыта
    }
});

// Очистка истории навигации при закрытии вкладки
chrome.tabs.onRemoved.addListener((tabId) => {
    TAB_NAV_HISTORY.delete(tabId);
});

// ─── Детекция competing через webNavigation ───
//
// Главный механизм: отслеживаем ВСЕ навигации (включая серверные редиректы)
// и строим историю доменов для каждой вкладки. Когда пользователь попадает
// на магазин с активным кэшбэком через цепочку, включающую конкурирующий
// домен, — это competing. При этом наша собственная активация (через наш сайт)
// корректно пропускается: в цепочке будет наш домен.

chrome.webNavigation.onCommitted.addListener(async (details) => {
    // Только основной фрейм (не iframes)
    if (details.frameId !== 0) return;

    const navDomain = extractDomain(details.url);
    if (!navDomain) return;

    if (!TAB_NAV_HISTORY.has(details.tabId)) {
        TAB_NAV_HISTORY.set(details.tabId, []);
    }
    const history = TAB_NAV_HISTORY.get(details.tabId);

    history.push({
        domain:    navDomain,
        timestamp: Date.now(),
        type:      details.transitionType,
        qualifiers: details.transitionQualifiers || [],
    });

    // Обрезаем старые записи
    const cutoff = Date.now() - NAV_HISTORY_WINDOW * 2; // храним с запасом
    while (history.length > 0 && history[0].timestamp < cutoff) {
        history.shift();
    }
    while (history.length > NAV_HISTORY_MAX_ENTRIES) {
        history.shift();
    }

    // Сохраняем affiliate-параметры при committed (быстрее чем onCompleted).
    // Это надёжнее чем ждать полной загрузки страницы — на медленных сайтах
    // onCompleted может сработать после истечения grace period.
    try {
        const activation = await getActivationStatus(navDomain);
        if (activation.state === CASHBACK_STATE.ACTIVE && activation.activated_at) {
            const age = Date.now() - new Date(activation.activated_at).getTime();
            if (age < 20000) {
                const commitParams = extractAffiliateParams(details.url);
                if (Object.keys(commitParams).length > 0) {
                    await saveActivationAffiliateParams(navDomain, commitParams);
                }
            }
        }
    } catch {
        // Ошибка чтения активации — не критично
    }
});

chrome.webNavigation.onCompleted.addListener(async (details) => {
    if (details.frameId !== 0) return;

    const navDomain = extractDomain(details.url);
    if (!navDomain) return;

    // Проверяем: есть ли активный кэшбэк для этого домена?
    const activation = await getActivationStatus(navDomain);
    if (activation.state !== CASHBACK_STATE.ACTIVE) return;

    const currentAffParams = extractAffiliateParams(details.url);
    const hasAffParams     = Object.keys(currentAffParams).length > 0;

    // Grace period: в первые 20 сек после активации.
    // В это время сохраняем affiliate-параметры из URL — они точно наши,
    // потому что это наш redirect через CPA-сеть.
    if (activation.activated_at) {
        const age = Date.now() - new Date(activation.activated_at).getTime();
        if (age < 20000) {
            // Сохраняем наши affiliate-параметры для будущего сравнения
            if (hasAffParams) {
                await saveActivationAffiliateParams(navDomain, currentAffParams);
            }
            return;
        }
    }

    // ── Метод 1: Сравнение affiliate-параметров ──
    // Самый надёжный: если в URL есть affiliate-параметры с ДРУГИМИ значениями
    // чем при нашей активации — кэшбэк точно перебит.
    // Прямые заходы (без affiliate-параметров) НЕ считаются competing.
    if (hasAffParams && activation.affiliate_params) {
        if (hasChangedAffiliateParams(activation.affiliate_params, currentAffParams)) {
            await handleCompetingNavigation(navDomain, details.tabId);
            return;
        }
    }

    // ── Метод 2: Любой внешний редирект на магазин ──
    // Ловит неизвестные промежуточные домены (напр. dorinebeaumont.com, кастомные
    // трекинг-домены CPA-сетей), которых нет в списке COMPETING_DOMAINS.
    // Работает даже когда конечный URL «чистый» от affiliate-меток: CPA-сети
    // часто передают трекинг через cookies при редиректе, а URL очищается.
    // Логика: любой серверный/быстрый клиентский редирект с внешнего домена
    // (не нашего сайта) на магазин с активным кэшбэком = перебитие.
    if (isExternalRedirectToStore(details.tabId, navDomain)) {
        await handleCompetingNavigation(navDomain, details.tabId);
        return;
    }

    // ── Метод 3: Анализ цепочки навигации (webNavigation history) ──
    // Ловит случаи когда пользователь пришёл через redirect с конкурирующего домена,
    // даже если affiliate-параметры не сохранены или URL чистый.
    const navHistory = TAB_NAV_HISTORY.get(details.tabId);
    if (!navHistory || navHistory.length < 2) return;
    const lastEntry = navHistory[navHistory.length - 1];

    // Прямой переход (набрал URL, закладка) — не competing
    if (lastEntry && (lastEntry.type === 'typed' || lastEntry.type === 'auto_bookmark')) return;

    if (isCompetingNavigation(details.tabId, navDomain)) {
        await handleCompetingNavigation(navDomain, details.tabId);
    }
});

// ─── Обработка сообщений ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch((e) => {
        sendResponse({ error: e.message });
    });
    return true; // async response
});

async function handleMessage(message, sender) {
    switch (message.type) {
        case 'GET_STORE_INFO': {
            const domain = message.domain;
            const store  = await CashbackAPI.findStoreByDomain(domain);
            if (!store) {
                if (sender.tab) {
                    await setIcon(sender.tab.id, ICON_STATES.GRAY);
                }
                return { store: null, state: CASHBACK_STATE.IDLE, activated: false };
            }
            const activation = await getActivationStatus(domain);
            // Синхронизируем иконку с актуальным состоянием
            if (sender.tab) {
                if (activation.state === CASHBACK_STATE.ACTIVE) {
                    await setIcon(sender.tab.id, ICON_STATES.GREEN);
                } else {
                    const badgeText = extractCashbackPercent(store.cashback_value);
                    await setIcon(sender.tab.id, ICON_STATES.RED, badgeText);
                }
            }
            return {
                store,
                state:     activation.state,
                activated: activation.state === CASHBACK_STATE.ACTIVE,
                activation,
            };
        }

        case 'COMPETING_DETECTED': {
            // Content script обнаружил конкурирующий клик через referrer/URL-анализ.
            // Переводим состояние active → competing, обновляем иконку и показываем уведомление.
            const domain     = message.domain;
            const activation = await getActivationStatus(domain);

            if (activation.state !== CASHBACK_STATE.ACTIVE) {
                return { success: false, reason: 'not_active' };
            }

            await updateActivationState(domain, CASHBACK_STATE.COMPETING);

            const store = await CashbackAPI.findStoreByDomain(domain);

            if (sender.tab) {
                const badgeText = extractCashbackPercent(store?.cashback_value);
                await setIcon(sender.tab.id, ICON_STATES.RED, badgeText);

                // Показываем competing-уведомление (игнорирует dismissed_{domain})
                if (store && (!store.popup_mode || store.popup_mode !== 'hide')) {
                    try {
                        await chrome.tabs.sendMessage(sender.tab.id, {
                            type:              'SHOW_NOTIFICATION',
                            store,
                            isAuthenticated:   true,
                            notification_type: 'competing',
                        });
                    } catch {
                        // Content script не отвечает — OK
                    }
                }
            }

            return { success: true };
        }

        case 'ACTIVATE': {
            const result = await CashbackAPI.activateCashback(message.productId);

            // Определяем домен магазина:
            // 1. Из сообщения (popup/content script на партнёрском сайте)
            // 2. Из API-ответа (нормализованный _store_domain)
            // 3. Fallback: из redirect_url (может быть CPA-трекер — ненадёжно)
            let domain = message.domain;
            if (!domain && result.domain) {
                domain = result.domain;
            }
            if (!domain && result.redirect_url) {
                try {
                    domain = new URL(result.redirect_url).hostname.replace(/^www\./i, '');
                } catch {}
            }

            if (domain) {
                // Получаем user_id — нужен для изоляции активаций между пользователями
                let userId = await getCachedUserId();
                if (!userId) {
                    try {
                        const profile = await CashbackAPI.fetchProfile();
                        userId = String(profile.user_id);
                        await setCachedUserId(userId);
                    } catch {
                        // Пользователь не авторизован — активация не сохраняется
                    }
                }
                if (userId) {
                    await saveActivation(domain, result, userId);
                }
            }

            // Обновляем иконку текущей вкладки
            if (sender.tab) {
                await updateIconForTab(sender.tab.id, sender.tab.url);
            }

            // Обновляем иконки на всех вкладках с этим доменом (для немедленного GREEN)
            if (domain) {
                await updateIconForAllTabsWithDomain(domain);
            }

            return result;
        }

        case 'GET_PROFILE': {
            const profile = await CashbackAPI.fetchProfile();
            await setCachedUserId(profile.user_id);
            return profile;
        }

        case 'GET_TRANSACTIONS': {
            return CashbackAPI.fetchTransactions(message.page || 1, message.perPage || 5);
        }

        case 'CHECK_AUTH': {
            try {
                const profile = await CashbackAPI.fetchProfile();
                await setCachedUserId(profile.user_id);
                return { authenticated: true, profile };
            } catch (e) {
                await clearCachedUserId();
                await clearAllActivations();
                return { authenticated: false, profile: null };
            }
        }

        case 'REFRESH_STORES': {
            await CashbackAPI.fetchStores(true);
            return { success: true };
        }

        case 'SITE_ACTIVATED': {
            // Активация инициирована кнопкой на сайте (не через popup расширения).
            // Content script страницы активации передаёт domain и click_id.
            let userId = await getCachedUserId();
            if (!userId) {
                try {
                    const profile = await CashbackAPI.fetchProfile();
                    userId = String(profile.user_id);
                    await setCachedUserId(userId);
                } catch {
                    return { success: false, reason: 'not_authenticated' };
                }
            }
            await saveActivation(message.domain, {
                click_id:            message.click_id,
                expires_at:          new Date(Date.now() + CASHBACK_CONFIG.ACTIVATION_TTL).toISOString(),
                redirect_url:        null,
                activation_page_url: null,
            }, userId);

            // Обновляем иконки на вкладках с этим доменом
            if (message.domain) {
                await updateIconForAllTabsWithDomain(message.domain);
            }

            return { success: true };
        }

        case 'GET_ICON_STATE': {
            const store = await CashbackAPI.findStoreByDomain(message.domain);
            if (!store) return { state: ICON_STATES.GRAY };
            const activation = await getActivationStatus(message.domain);
            return {
                state:     activation.state,
                activated: activation.state === CASHBACK_STATE.ACTIVE,
                store,
                activation,
            };
        }

        case 'CHECK_AFFILIATE_PARAMS': {
            // Content script передаёт текущий URL для проверки affiliate-параметров
            // и внешних редиректов. Если параметры изменились или был внешний
            // редирект (даже с чистым URL) — кэшбэк перебит чужим сервисом.
            const chkDomain    = message.domain;
            const chkActivation = await getActivationStatus(chkDomain);

            if (chkActivation.state !== CASHBACK_STATE.ACTIVE) {
                return { competing: false };
            }

            // Метод 1: Сравнение affiliate-параметров (если есть и в URL, и сохранённые)
            const currentParams = extractAffiliateParams(message.url);
            const hasParams     = Object.keys(currentParams).length > 0;

            if (hasParams && chkActivation.affiliate_params) {
                if (hasChangedAffiliateParams(chkActivation.affiliate_params, currentParams)) {
                    return { competing: true };
                }
            }

            // Метод 2: Внешний редирект (даже с чистым URL)
            // CPA-сети часто передают трекинг через cookies при редиректе,
            // а конечный URL приходит без affiliate-меток.
            if (sender.tab && isExternalRedirectToStore(sender.tab.id, chkDomain)) {
                return { competing: true };
            }

            return { competing: false };
        }

        default:
            return { error: 'Unknown message type' };
    }
}

// ─── Управление иконкой ───

async function updateIconForTab(tabId, url) {
    try {
        const domain = extractDomain(url);
        if (!domain) {
            await setIcon(tabId, ICON_STATES.GRAY);
            return;
        }

        // Если кеш устарел — обновляем ДО поиска магазина, чтобы получить актуальный
        // popup_mode и другие настройки (изменения применяются сразу после обновления в админке)
        const cacheData = await chrome.storage.local.get('stores_updated_at');
        const cacheAge  = Date.now() - (cacheData.stores_updated_at || 0);
        if (cacheAge > CASHBACK_CONFIG.STORES_CACHE_TTL) {
            try {
                await CashbackAPI.fetchStores(true);
            } catch {
                // Используем устаревший кеш если обновить не удалось
            }
        }

        const store = await CashbackAPI.findStoreByDomain(domain);
        if (!store) {
            await setIcon(tabId, ICON_STATES.GRAY);
            return;
        }

        const badgeText = extractCashbackPercent(store.cashback_value);

        // Проверяем активацию
        let activation = await getActivationStatus(domain);

        // Если есть активация, но не удалось проверить пользователя — разрешаем через API
        if (activation.needs_auth_check) {
            try {
                const profile = await CashbackAPI.fetchProfile();
                await setCachedUserId(profile.user_id);
                // Повторная проверка с кешированным user_id
                activation = await getActivationStatus(domain);
            } catch {
                // Не авторизован — очищаем всё
                await clearCachedUserId();
                await clearAllActivations();
                activation = { state: CASHBACK_STATE.IDLE };
            }
        }

        if (activation.state === CASHBACK_STATE.ACTIVE) {
            await setIcon(tabId, ICON_STATES.GREEN, '');
            // Уведомление не нужно — кэшбэк активен
            return;
        }

        // RED для competing / expired / idle
        await setIcon(tabId, ICON_STATES.RED, badgeText);

        // Для competing — уведомление уже было показано при обнаружении, не дублируем
        if (activation.state === CASHBACK_STATE.COMPETING) {
            return;
        }

        // Для idle и expired — обычное уведомление (если разрешено)
        if (store.popup_mode === 'hide') {
            return;
        }

        // Проверяем авторизацию для уведомления
        let isAuthenticated = false;
        try {
            const profile = await CashbackAPI.fetchProfile();
            isAuthenticated = !!profile;
            if (profile) {
                await setCachedUserId(profile.user_id);
            }
        } catch {
            // Не авторизован — покажем кнопку входа
        }

        try {
            await chrome.tabs.sendMessage(tabId, {
                type:              'SHOW_NOTIFICATION',
                store,
                isAuthenticated,
                notification_type: 'activate',
            });
        } catch {
            // Content script ещё не загружен — он сам запросит через fallback
        }
    } catch (e) {
        // При ошибке — серая иконка
        await setIcon(tabId, ICON_STATES.GRAY);
    }
}

async function setIcon(tabId, state, badgeText = '') {
    try {
        await chrome.action.setIcon({
            tabId,
            path: {
                16:  chrome.runtime.getURL(`icons/icon-${state}-16.png`),
                32:  chrome.runtime.getURL(`icons/icon-${state}-32.png`),
                48:  chrome.runtime.getURL(`icons/icon-${state}-48.png`),
                128: chrome.runtime.getURL(`icons/icon-${state}-128.png`),
            },
        });

        if (badgeText) {
            await chrome.action.setBadgeText({ tabId, text: badgeText });
            await chrome.action.setBadgeBackgroundColor({
                tabId,
                color: state === ICON_STATES.RED ? '#e74c3c' : '#27ae60',
            });
        } else {
            await chrome.action.setBadgeText({ tabId, text: '' });
        }
    } catch (e) {
        console.warn('[Cashback] setIcon error:', e && e.message);
    }
}

// ─── Статус активации ───

async function getActivationStatus(domain) {
    const cleanDomain = domain.replace(/^www\./i, '');
    const key         = `activation_${cleanDomain}`;

    const data       = await chrome.storage.session.get(key);
    const activation = data[key];

    if (!activation) {
        return { state: CASHBACK_STATE.IDLE };
    }

    // Если уже в состоянии expired — возвращаем как есть (запись сохраняется для UX)
    if (activation.state === CASHBACK_STATE.EXPIRED) {
        return {
            state:        CASHBACK_STATE.EXPIRED,
            activated_at: activation.activated_at,
            expires_at:   activation.expires_at,
            click_id:     activation.click_id,
        };
    }

    // Проверяем TTL (только для active/competing)
    const elapsed = Date.now() - activation.timestamp;
    if (elapsed > CASHBACK_CONFIG.ACTIVATION_TTL) {
        // Переводим в expired — НЕ удаляем, чтобы пользователь видел "Время истекло"
        await updateActivationState(cleanDomain, CASHBACK_STATE.EXPIRED);
        return {
            state:        CASHBACK_STATE.EXPIRED,
            activated_at: activation.activated_at,
            expires_at:   activation.expires_at,
            click_id:     activation.click_id,
        };
    }

    // Проверяем принадлежность пользователю
    if (!activation.user_id) {
        // Legacy-запись без user_id — удаляем
        await chrome.storage.session.remove(key);
        return { state: CASHBACK_STATE.IDLE };
    }

    const currentUserId = await getCachedUserId();

    if (currentUserId && activation.user_id !== currentUserId) {
        // Активация принадлежит другому пользователю
        return { state: CASHBACK_STATE.IDLE };
    }

    if (!currentUserId) {
        // Не знаем текущего пользователя — нужна проверка через API
        const remainingMs = CASHBACK_CONFIG.ACTIVATION_TTL - elapsed;
        return {
            state:            activation.state || CASHBACK_STATE.ACTIVE,
            needs_auth_check: true,
            activated_at:     activation.activated_at,
            expires_at:       activation.expires_at,
            click_id:         activation.click_id,
            affiliate_params: activation.affiliate_params || null,
            remaining_minutes: Math.ceil(remainingMs / 60000),
        };
    }

    const remainingMs = CASHBACK_CONFIG.ACTIVATION_TTL - elapsed;
    return {
        state:             activation.state || CASHBACK_STATE.ACTIVE,
        activated_at:      activation.activated_at,
        expires_at:        activation.expires_at,
        click_id:          activation.click_id,
        affiliate_params:  activation.affiliate_params || null,
        remaining_minutes: Math.ceil(remainingMs / 60000),
        // Обратная совместимость
        activated:         (activation.state || CASHBACK_STATE.ACTIVE) === CASHBACK_STATE.ACTIVE,
    };
}

async function saveActivation(domain, result, userId) {
    const cleanDomain = domain.replace(/^www\./i, '');
    const key         = `activation_${cleanDomain}`;

    await chrome.storage.session.set({
        [key]: {
            state:      CASHBACK_STATE.ACTIVE,   // новое поле
            timestamp:  Date.now(),
            activated_at: result.expires_at
                ? new Date(Date.now()).toISOString()
                : null,
            expires_at:          result.expires_at,
            click_id:            result.click_id,
            redirect_url:        result.redirect_url,
            activation_page_url: result.activation_page_url || null,
            user_id:             userId ? String(userId) : null,
        },
    });

    // Планируем alarm для смены иконки на красную при истечении TTL.
    // chrome.alarms требует минимум ~1 мин, но точная минута не критична для UX.
    const delayMinutes = CASHBACK_CONFIG.ACTIVATION_TTL / 60000;
    chrome.alarms.create(`expire_${cleanDomain}`, { delayInMinutes: delayMinutes });
}

/**
 * Обновляет только поле state в существующей записи активации.
 * Используется для переходов: active→competing, active→expired.
 */
async function updateActivationState(domain, newState) {
    const cleanDomain = domain.replace(/^www\./i, '');
    const key         = `activation_${cleanDomain}`;

    const data       = await chrome.storage.session.get(key);
    const activation = data[key];
    if (!activation) return;

    await chrome.storage.session.set({
        [key]: { ...activation, state: newState },
    });
}

// ─── Синхронизация активации из cookie (надёжный fallback) ───
//
// PHP устанавливает cookie cb_activation при обработке ?cashback_click=.
// Расширение читает его здесь через chrome.cookies API — без зависимости
// от состояния SW, кеша userId и SameSite-ограничений WP auth cookie.

async function syncActivationFromCookie() {
    try {
        const cookie = await chrome.cookies.get({
            url:  CASHBACK_CONFIG.SITE_URL,
            name: 'cb_activation',
        });
        if (!cookie || !cookie.value) return;

        const data = JSON.parse(decodeURIComponent(cookie.value));
        if (!data.click_id || !data.domain || !data.ts) return;

        // Проверяем TTL (ts — unix timestamp в секундах)
        const ageSeconds = Math.floor(Date.now() / 1000) - data.ts;
        if (ageSeconds > 1800) return;

        // Не перезаписываем уже сохранённую активацию для этого клика
        const storageKey = `activation_${data.domain}`;
        const existing   = await chrome.storage.session.get(storageKey);
        if (existing[storageKey] && existing[storageKey].click_id === data.click_id) return;

        // Получаем userId
        let userId = await getCachedUserId();
        if (!userId) {
            try {
                const profile = await CashbackAPI.fetchProfile();
                userId = String(profile.user_id);
                await setCachedUserId(userId);
            } catch {
                return; // Пользователь не авторизован — активация не сохраняется
            }
        }

        await saveActivation(data.domain, {
            click_id:            data.click_id,
            expires_at:          new Date((data.ts + 1800) * 1000).toISOString(),
            redirect_url:        null,
            activation_page_url: null,
        }, userId);

    } catch {
        // Игнорируем: нет разрешения, JSON невалиден и т.п.
    }
}

async function cleanupExpiredActivations() {
    const all         = await chrome.storage.session.get(null);
    const keysToUpdate = [];
    const keysToRemove = [];
    const TWO_HOURS    = 2 * 60 * 60 * 1000;

    for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith('activation_') || !value.timestamp) continue;

        const elapsed = Date.now() - value.timestamp;

        if (value.state === CASHBACK_STATE.EXPIRED) {
            // Удаляем expired записи старше 2 часов
            if (elapsed > TWO_HOURS) {
                keysToRemove.push(key);
            }
        } else if (elapsed > CASHBACK_CONFIG.ACTIVATION_TTL) {
            // Переводим active/competing в expired (а не удаляем)
            keysToUpdate.push({ key, value });
        }
    }

    if (keysToRemove.length > 0) {
        await chrome.storage.session.remove(keysToRemove);
    }

    for (const { key, value } of keysToUpdate) {
        await chrome.storage.session.set({
            [key]: { ...value, state: CASHBACK_STATE.EXPIRED },
        });
    }
}

// ─── Определение страницы активации (server-side redirect) ───

/**
 * Проверяет, является ли URL промежуточной страницей активации кэшбэка.
 * Признак: домен нашего сайта + параметры cashback_go=1 и click_id.
 */
function isActivationPageUrl(url) {
    try {
        const parsed = new URL(url);
        const site   = new URL(CASHBACK_CONFIG.SITE_URL);
        return parsed.hostname === site.hostname &&
               parsed.searchParams.get('cashback_go') === '1' &&
               !!parsed.searchParams.get('click_id');
    } catch {
        return false;
    }
}

/**
 * Вызывается когда браузер открыл страницу активации (после server-side redirect
 * через ?cashback_click=). Запрашивает у REST API домен назначения по click_id
 * и сохраняет активацию, чтобы к моменту перехода на партнёрский сайт расширение
 * знало что кэшбэк активен и показывало зелёный значок.
 */
async function handleActivationPageNavigation(url) {
    try {
        const parsed   = new URL(url);
        const click_id = parsed.searchParams.get('click_id');
        if (!click_id) return;

        const data = await CashbackAPI.request('/session-status', { click_id });
        if (data.activated && data.domain) {
            let userId = await getCachedUserId();
            if (!userId) {
                // user_id не закеширован в этой сессии — фетчим профиль.
                // Без user_id активация будет отвергнута в getActivationStatus().
                const profile = await CashbackAPI.fetchProfile();
                userId = String(profile.user_id);
                await setCachedUserId(userId);
            }
            await saveActivation(data.domain, data, userId);
        }
    } catch (e) {
        // Не авторизован (гость) или другая ошибка — молча игнорируем,
        // для гостей кэшбэк не начисляется и зелёный значок не нужен.
        console.warn('[Cashback] handleActivationPageNavigation failed:', e.message);
    }
}

// ─── Обновление иконок на всех вкладках с определённым доменом ───

async function updateIconForAllTabsWithDomain(domain) {
    try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (!tab.url) continue;
            const tabDomain = extractDomain(tab.url);
            if (tabDomain === domain) {
                await updateIconForTab(tab.id, tab.url);
            }
        }
    } catch {
        // Ошибка перебора вкладок — не критична
    }
}

// ─── Детекция competing: helpers ───

/**
 * Извлекает из URL известные affiliate-параметры.
 * Возвращает объект {param_name: value} или пустой объект.
 */
function extractAffiliateParams(url) {
    try {
        const params = new URL(url).searchParams;
        const result = {};
        for (const key of AFFILIATE_TRACKING_PARAMS) {
            const val = params.get(key);
            if (val) result[key] = val;
        }
        return result;
    } catch {
        return {};
    }
}

/**
 * Сравнивает сохранённые affiliate-параметры с текущими.
 * Возвращает true если хотя бы один общий параметр имеет ДРУГОЕ значение.
 * Если в текущем URL нет affiliate-параметров (прямой заход) — false.
 */
function hasChangedAffiliateParams(saved, current) {
    if (!saved || !current) return false;
    for (const [key, savedVal] of Object.entries(saved)) {
        if (current[key] && current[key] !== savedVal) {
            return true;
        }
    }
    return false;
}

/**
 * Сохраняет affiliate-параметры нашей активации.
 * Вызывается во время grace period, когда пользователь впервые попадает
 * на магазин после нашего redirect — параметры в URL точно наши.
 */
async function saveActivationAffiliateParams(domain, params) {
    const cleanDomain = domain.replace(/^www\./i, '');
    const key         = `activation_${cleanDomain}`;
    const data        = await chrome.storage.session.get(key);
    const activation  = data[key];
    if (!activation) return;

    // Не перезаписываем если уже сохранены (первое приземление — самое точное)
    if (activation.affiliate_params) return;

    await chrome.storage.session.set({
        [key]: { ...activation, affiliate_params: params },
    });
}

/**
 * Проверяет, является ли домен конкурирующим кэшбэк-сервисом или affiliate-сетью.
 */
function isCompetingDomain(hostname) {
    const h = hostname.replace(/^www\./i, '').toLowerCase();
    return COMPETING_DOMAINS.some(d => h === d || h.endsWith('.' + d));
}

/**
 * Определяет, пришёл ли пользователь на магазин через внешний редирект
 * (не через наш сайт). Не требует знания конкретного конкурирующего домена.
 *
 * Проверяет: (1) серверный редирект (302 и т.п.) — по qualifier "server_redirect"
 * в записи магазина, (2) клиентский редирект (JS window.location) — по быстрой
 * смене доменов (< 10 сек). Если наш сайт в цепочке — это наша активация.
 *
 * Пример: dorinebeaumont.com → (302) → cosmogon.ru
 *   → server_redirect в записи cosmogon.ru → external = true → competing
 */
function isExternalRedirectToStore(tabId, storeDomain) {
    const history = TAB_NAV_HISTORY.get(tabId);
    if (!history || history.length < 2) return false;

    const ourHost = extractDomain(CASHBACK_CONFIG.SITE_URL);
    const cutoff  = Date.now() - NAV_HISTORY_WINDOW;

    // Находим последнюю запись для домена магазина
    const storeEntry = history[history.length - 1];
    if (!storeEntry || storeEntry.domain !== storeDomain) return false;

    const isServerRedirect = storeEntry.qualifiers &&
                             storeEntry.qualifiers.includes('server_redirect');

    // Проходим от предпоследней записи назад по цепочке
    for (let i = history.length - 2; i >= 0; i--) {
        const entry = history[i];
        if (entry.timestamp < cutoff) break;

        // Пропускаем записи самого магазина (внутренние навигации)
        if (entry.domain === storeDomain) continue;

        // Наш сайт в цепочке → это наша собственная активация
        if (entry.domain === ourHost) return false;

        // Серверный редирект с внешнего домена → точно перебитие
        if (isServerRedirect) return true;

        // Клиентский редирект (JS): быстрая навигация < 10 секунд между
        // внешним доменом и магазином (JS-трекеры перенаправляют моментально)
        const timeDiff = storeEntry.timestamp - entry.timestamp;
        if (timeDiff < 10000) return true;

        // Если внешний домен найден, но промежуток слишком большой — не редирект
        break;
    }

    return false;
}

/**
 * Анализирует навигационную историю вкладки и определяет,
 * пришёл ли пользователь на магазин через конкурирующий сервис.
 *
 * Логика: проверяем последние N секунд навигации. Если в цепочке есть
 * конкурирующий домен, но НЕТ нашего сайта — это competing.
 * Если наш сайт есть — это наша собственная активация через CPA.
 */
function isCompetingNavigation(tabId, storeDomain) {
    const history = TAB_NAV_HISTORY.get(tabId);
    if (!history || history.length < 2) return false;

    const ourHost = extractDomain(CASHBACK_CONFIG.SITE_URL);
    const cutoff  = Date.now() - NAV_HISTORY_WINDOW;

    let foundCompeting = false;
    let foundOurSite   = false;

    // Проходим от предпоследней записи (последняя — текущая страница) к старым
    for (let i = history.length - 2; i >= 0; i--) {
        const entry = history[i];
        if (entry.timestamp < cutoff) break;
        if (entry.domain === storeDomain) continue; // пропускаем сам магазин

        if (entry.domain === ourHost) {
            foundOurSite = true;
            break; // Наш сайт в цепочке → это наша активация, не competing
        }

        if (isCompetingDomain(entry.domain)) {
            foundCompeting = true;
            // Не break — продолжаем искать наш сайт выше в цепочке
        }
    }

    return foundCompeting && !foundOurSite;
}

/**
 * Обрабатывает обнаруженный competing: обновляет состояние,
 * иконку и отправляет уведомление на все вкладки с этим доменом.
 */
async function handleCompetingNavigation(domain, triggerTabId) {
    await updateActivationState(domain, CASHBACK_STATE.COMPETING);

    const store     = await CashbackAPI.findStoreByDomain(domain);
    const badgeText = extractCashbackPercent(store?.cashback_value);

    // Обновляем иконку на вкладке-источнике
    await setIcon(triggerTabId, ICON_STATES.RED, badgeText);

    // Показываем competing-уведомление
    if (store && store.popup_mode !== 'hide') {
        try {
            await chrome.tabs.sendMessage(triggerTabId, {
                type:              'SHOW_NOTIFICATION',
                store,
                isAuthenticated:   true,
                notification_type: 'competing',
            });
        } catch {
            // Content script ещё не загружен
        }
    }

    // Обновляем все остальные вкладки с этим доменом
    await updateIconForAllTabsWithDomain(domain);
}

// ─── Утилиты ───

function extractDomain(url) {
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        return parsed.hostname.replace(/^www\./i, '');
    } catch {
        return null;
    }
}

function extractCashbackPercent(value) {
    if (!value) return '';
    // Извлекаем число из строк вроде "до 7%", "до 81%", "388р."
    const match = value.match(/(\d+)\s*%/);
    if (match) return match[1] + '%';
    // Для сумм
    const matchSum = value.match(/(\d+)\s*р/);
    if (matchSum) return matchSum[1] + 'р';
    return '';
}
