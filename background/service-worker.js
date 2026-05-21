/**
 * Service Worker для браузерного расширения кэшбэк-сервиса.
 *
 * Управляет:
 * - Определением магазинов-партнёров по домену текущей вкладки
 * - Состоянием иконки (GRAY / RED / GREEN)
 * - Кешем списка магазинов
 * - Сообщениями от popup и content script (savello-site.js на savelloclub.ru)
 *
 * Расширение НЕ детектирует «перебитие атрибуции» и НЕ предлагает
 * реактивировать кэшбэк через нашу партнёрку, если пользователь
 * пришёл в магазин через другого партнёра или органически. Любая
 * активация выполняется только по явному клику пользователя,
 * инициирующему НОВЫЙ заход через savelloclub.ru:
 *   - Кнопка «Активировать кэшбэк» в попапе расширения
 *   - Кнопка «Получить кэшбэк» на странице товара savelloclub.ru
 *
 * Активация и любая запись в storage блокируются до получения
 * пользовательского согласия (онбординг открывается при первой
 * установке расширения).
 */

importScripts('../utils/config.js', '../utils/api.js');

// ─── Константы ───

const ICON_STATES = {
    GRAY:  'gray',
    RED:   'red',
    GREEN: 'green',
};

/**
 * Состояния кэшбэка для домена:
 *   idle    — нет активации
 *   active  — наша активация действует (зелёный значок)
 *   expired — TTL истёк, запись сохраняется для UX «Время истекло»
 */
const CASHBACK_STATE = {
    IDLE:    'idle',
    ACTIVE:  'active',
    EXPIRED: 'expired',
};

const ALARM_REFRESH_STORES      = 'refresh-stores';
const ALARM_CLEANUP_ACTIVATIONS = 'cleanup-activations';
const CURRENT_USER_KEY          = 'current_user_id';
const CONSENT_KEY               = 'consent_at';

// tabId -> domain последней проигранной анимации.
// Не повторяем мигание при F5, переключении вкладок и повторных GET_STORE_INFO.
const animatedDomainPerTab = new Map();

// tabId -> { intervalId, timeoutId } активной анимации мигания.
// Нужно чтобы отменить её при смене состояния (GREEN/GRAY) или закрытии вкладки.
const activeAnimations = new Map();

// ─── Согласие пользователя ───

async function hasConsent() {
    const data = await chrome.storage.local.get(CONSENT_KEY);
    return !!data[CONSENT_KEY];
}

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

chrome.runtime.onInstalled.addListener(async (details) => {
    // Загрузить список магазинов при установке/обновлении
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

    if (details.reason === 'install') {
        // Первая установка — показываем экран онбординга с согласием.
        // До получения consent функции активации заблокированы.
        try {
            await chrome.tabs.create({
                url: chrome.runtime.getURL('onboarding/onboarding.html'),
            });
        } catch {
            // Не критично — пользователь увидит приглашение в попапе расширения
        }
    }

    if (details.reason === 'update') {
        // Миграция: удалить устаревшее состояние competing и связанные ключи
        // из предыдущих версий расширения (≤ 1.5.4).
        await migrateRemoveLegacyCompetingState();
    }
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
        // Блокируется до consent — без согласия расширение не сохраняет активации.
        await syncActivationFromCookie();
        await updateIconForTab(tabId, tab.url);
    }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab.url) {
            // Переключение вкладок не должно триггерить мигание — только реальная навигация.
            await updateIconForTab(activeInfo.tabId, tab.url, { allowAnimation: false });
        }
    } catch (e) {
        // Вкладка может быть уже закрыта
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    cancelIconAnimation(tabId);
    animatedDomainPerTab.delete(tabId);
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

        case 'ACTIVATE': {
            // Любая активация требует явного согласия пользователя.
            if (!(await hasConsent())) {
                return { error: 'no_consent', onboarding_url: chrome.runtime.getURL('onboarding/onboarding.html') };
            }

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

        case 'CHECK_CONSENT': {
            return { consent: await hasConsent() };
        }

        case 'OPEN_ONBOARDING': {
            try {
                await chrome.tabs.create({
                    url: chrome.runtime.getURL('onboarding/onboarding.html'),
                });
            } catch {}
            return { success: true };
        }

        case 'REFRESH_STORES': {
            await CashbackAPI.fetchStores(true);
            return { success: true };
        }

        case 'SITE_ACTIVATED': {
            // Активация инициирована кнопкой на сайте (не через popup расширения).
            // Content script страницы активации передаёт domain и click_id.
            // Без consent активация в storage не сохраняется — пользователь
            // увидит только обычное поведение сайта (PHP cookie cb_activation),
            // но расширение не подсветит иконку зелёным.
            if (!(await hasConsent())) {
                return { success: false, reason: 'no_consent' };
            }

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

        default:
            return { error: 'Unknown message type' };
    }
}

// ─── Управление иконкой ───

async function updateIconForTab(tabId, url, opts = {}) {
    try {
        const domain = extractDomain(url);
        if (!domain) {
            cancelIconAnimation(tabId);
            animatedDomainPerTab.delete(tabId);
            await setIcon(tabId, ICON_STATES.GRAY);
            return;
        }

        // Если кеш устарел — обновляем ДО поиска магазина, чтобы получить актуальный
        // список (изменения применяются сразу после обновления в админке)
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
            cancelIconAnimation(tabId);
            animatedDomainPerTab.delete(tabId);
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
            cancelIconAnimation(tabId);
            animatedDomainPerTab.delete(tabId);
            await setIcon(tabId, ICON_STATES.GREEN, '');
            return;
        }

        // RED для всех остальных случаев (idle / expired):
        // расширение НЕ различает «пользователь не нажал активацию»
        // и «пользователь пришёл через другого партнёра/органически».
        // Информер на странице магазина не показываем — пользователь
        // увидит цвет иконки и при необходимости откроет попап.
        const lastAnimated = animatedDomainPerTab.get(tabId);
        const shouldAnimate = opts.allowAnimation !== false && lastAnimated !== domain;

        if (shouldAnimate) {
            animatedDomainPerTab.set(tabId, domain);
            await animateIconGreenToRed(tabId);
        } else {
            cancelIconAnimation(tabId);
            await setIcon(tabId, ICON_STATES.RED, badgeText);
        }
    } catch (e) {
        // При ошибке — серая иконка
        cancelIconAnimation(tabId);
        animatedDomainPerTab.delete(tabId);
        await setIcon(tabId, ICON_STATES.GRAY);
    }
}

// eslint-disable-next-line no-unused-vars
async function setIcon(tabId, state, _badgeText = '') {
    // Badge с процентом кэшбэка отключён по UX-решению (icon-only).
    // Параметр _badgeText сохранён для обратной совместимости с callsite'ами,
    // но всегда игнорируется — badge принудительно очищается.
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

        await chrome.action.setBadgeText({ tabId, text: '' });
    } catch (e) {
        console.warn('[Cashback] setIcon error:', e && e.message);
    }
}

function cancelIconAnimation(tabId) {
    const anim = activeAnimations.get(tabId);
    if (!anim) return;
    clearInterval(anim.intervalId);
    clearTimeout(anim.timeoutId);
    activeAnimations.delete(tabId);
}

// Чередование GREEN↔RED 5 секунд для привлечения внимания на партнёрском
// сайте, затем стабильное состояние RED.
async function animateIconGreenToRed(tabId) {
    cancelIconAnimation(tabId);

    const FRAMES = [
        ICON_STATES.GREEN,
        ICON_STATES.RED,
        ICON_STATES.GREEN,
        ICON_STATES.RED,
        ICON_STATES.GREEN,
        ICON_STATES.RED,
        ICON_STATES.GREEN,
        ICON_STATES.RED,
        ICON_STATES.GREEN,
        ICON_STATES.RED,
    ];
    const FRAME_MS = 500;
    let i = 0;

    await setIcon(tabId, FRAMES[i++]);

    const intervalId = setInterval(() => {
        if (i >= FRAMES.length) return;
        setIcon(tabId, FRAMES[i++]);
    }, FRAME_MS);

    const timeoutId = setTimeout(() => {
        clearInterval(intervalId);
        activeAnimations.delete(tabId);
        setIcon(tabId, ICON_STATES.RED);
    }, FRAMES.length * FRAME_MS);

    activeAnimations.set(tabId, { intervalId, timeoutId });
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

    // Defensive guard: если миграция со старой версии не успела отработать
    // (SW мог не запуститься после update), удаляем legacy-запись competing
    // и возвращаем idle — пользователь увидит обычное RED-состояние.
    if (activation.state === 'competing') {
        await chrome.storage.session.remove(key);
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

    // Проверяем TTL (только для active)
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
            state:             activation.state || CASHBACK_STATE.ACTIVE,
            needs_auth_check:  true,
            activated_at:      activation.activated_at,
            expires_at:        activation.expires_at,
            click_id:          activation.click_id,
            remaining_minutes: Math.ceil(remainingMs / 60000),
        };
    }

    const remainingMs = CASHBACK_CONFIG.ACTIVATION_TTL - elapsed;
    return {
        state:             activation.state || CASHBACK_STATE.ACTIVE,
        activated_at:      activation.activated_at,
        expires_at:        activation.expires_at,
        click_id:          activation.click_id,
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
            state:      CASHBACK_STATE.ACTIVE,
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
 * Используется для перехода active → expired по TTL-алярму.
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
    // Без согласия пользователя расширение не сохраняет активации в storage.
    if (!(await hasConsent())) return;

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
    const all          = await chrome.storage.session.get(null);
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
            // Переводим active в expired (а не удаляем)
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

// ─── Миграция со старых версий ───

/**
 * Чистит остатки удалённого механизма competing/реактивации:
 *   - ключи competing_dismissed_*
 *   - активации в state === 'competing'
 *   - поле affiliate_params в записях активации
 */
async function migrateRemoveLegacyCompetingState() {
    try {
        const all      = await chrome.storage.session.get(null);
        const toRemove = [];
        const toUpdate = [];

        for (const [key, value] of Object.entries(all)) {
            if (key.startsWith('competing_dismissed_')) {
                toRemove.push(key);
                continue;
            }

            if (!key.startsWith('activation_') || !value || typeof value !== 'object') continue;

            if (value.state === 'competing') {
                // Активация в обнулённом state — пусть пользователь увидит обычное
                // RED-состояние (idle) или активирует заново через попап.
                toRemove.push(key);
                continue;
            }

            if (value.affiliate_params) {
                const cleaned = { ...value };
                delete cleaned.affiliate_params;
                toUpdate.push({ key, value: cleaned });
            }
        }

        if (toRemove.length > 0) {
            await chrome.storage.session.remove(toRemove);
        }
        for (const { key, value } of toUpdate) {
            await chrome.storage.session.set({ [key]: value });
        }
    } catch {
        // Миграция не критична — игнорируем
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
    // Без consent активации не сохраняются.
    if (!(await hasConsent())) return;

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
                // Синхронизация состояния (активация/expire) — не реальная навигация,
                // мигание не запускаем.
                await updateIconForTab(tab.id, tab.url, { allowAnimation: false });
            }
        }
    } catch {
        // Ошибка перебора вкладок — не критична
    }
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
