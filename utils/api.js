/**
 * API-клиент для REST API кэшбэк-сервиса.
 *
 * Все методы возвращают Promise.
 * Авторизация через WordPress cookies (credentials: include).
 *
 * Транспорт fetch: через offscreen document (если доступен) — обходит баг
 * Яндекс.Браузера, в котором fetch из обработчиков service worker'а
 * (onMessage / onAlarm / onInstalled) зависает на 60 сек до timeout. В
 * offscreen контексте (обычная HTML-страница) сетевой стек работает
 * корректно. В Chrome/Edge offscreen тоже работает прозрачно. На клиенте
 * без offscreen API (popup/content-script) — fallback на прямой fetch.
 */

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
let __offscreenSetup = null; // Promise, кешируем чтобы не плодить createDocument()

async function ensureOffscreenDocument() {
    if (typeof chrome === 'undefined' || !chrome.offscreen) {
        return false;
    }
    if (__offscreenSetup) {
        return __offscreenSetup;
    }
    __offscreenSetup = (async () => {
        try {
            // Если документ уже существует, createDocument() выбрасывает.
            // hasDocument() недоступен в старых сборках Chromium-форков,
            // поэтому ловим ошибку «уже создан» и считаем это успехом.
            await chrome.offscreen.createDocument({
                url:           OFFSCREEN_PATH,
                reasons:       ['WORKERS'],
                justification: 'Fetch authenticated cashback API from non-SW context to bypass Yandex Browser SW network bug.',
            });
            return true;
        } catch (e) {
            const msg = (e && e.message) || '';
            // Document already exists — это и есть успех.
            if (/already|single offscreen|already exists/i.test(msg)) {
                return true;
            }
            __offscreenSetup = null; // Чтобы можно было ретраить в будущем
            return false;
        }
    })();
    return __offscreenSetup;
}

async function fetchViaOffscreen(url, options) {
    // Один retry на случай, если offscreen был выгружен браузером после idle —
    // sendMessage упадёт с "Could not establish connection", пересоздаём документ.
    for (let attempt = 0; attempt < 2; attempt++) {
        const ready = await ensureOffscreenDocument();
        if (!ready) {
            return null;
        }
        try {
            return await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage(
                    { type: 'OFFSCREEN_FETCH', url, options },
                    (response) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            return;
                        }
                        if (!response) {
                            reject(new Error('No response from offscreen'));
                            return;
                        }
                        resolve(response);
                    }
                );
            });
        } catch (e) {
            const msg = (e && e.message) || '';
            const retriable = /establish connection|no response|message port closed/i.test(msg);
            if (attempt === 0 && retriable) {
                __offscreenSetup = null;
                continue;
            }
            throw e;
        }
    }
    return null;
}

const CashbackAPI = {
    /**
     * Выполнение запроса к REST API.
     *
     * @param {string} endpoint - Путь эндпоинта (напр. '/stores')
     * @param {Object} params   - Query-параметры
     * @returns {Promise<Object>}
     */
    async request(endpoint, params = {}, method = 'GET') {
        const url = new URL(CASHBACK_CONFIG.API_BASE + endpoint);

        // Cache-buster: гарантирует, что браузер никогда не воспроизведёт
        // закешированный редирект/ошибку для REST-пути расширения (инцидент
        // 2026-04-23: Yandex Browser залип на старом 301 к /me).
        url.searchParams.set('_', String(Date.now()));

        const fetchOptions = {
            method,
            credentials: 'include',
            cache: 'no-store',
            headers: {
                'Accept': 'application/json',
                'X-Cashback-Extension': '1',
            },
        };

        if (method === 'GET') {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    url.searchParams.set(key, value);
                }
            });
        } else {
            fetchOptions.headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify(params);
        }

        // Транспорт: offscreen document → fallback на прямой fetch.
        let status, statusText, contentType, bodyText;
        const offscreenResp = await fetchViaOffscreen(url.toString(), fetchOptions).catch(() => null);
        if (offscreenResp && offscreenResp.ok) {
            status      = offscreenResp.status;
            statusText  = offscreenResp.statusText;
            contentType = offscreenResp.contentType;
            bodyText    = offscreenResp.text;
        } else {
            // offscreen недоступен (popup / старый браузер) либо fetch упал в нём —
            // пробуем напрямую. На Edge/Chrome это рабочий путь; на Яндексе из SW
            // именно эта ветка и виснет, поэтому offscreen — приоритет.
            const response = await fetch(url.toString(), fetchOptions);
            status      = response.status;
            statusText  = response.statusText;
            contentType = response.headers.get('content-type') || '';
            bodyText    = await response.text();
        }

        if (status === 401) {
            throw new AuthError('Необходима авторизация');
        }

        if (status === 429) {
            throw new RateLimitError('Слишком много запросов');
        }

        if (status < 200 || status >= 300) {
            let message = `HTTP ${status}`;
            try {
                const body = JSON.parse(bodyText);
                if (body && body.message) message = body.message;
            } catch {
                // не JSON — оставляем generic message
            }
            throw new ApiError(message, status);
        }

        if (!contentType.includes('application/json')) {
            throw new ApiError('Неожиданный формат ответа', status);
        }

        try {
            return JSON.parse(bodyText);
        } catch (e) {
            throw new ApiError('Невалидный JSON в ответе', status);
        }
    },

    /**
     * Получить список магазинов с кэшбэком.
     * Кешируется в chrome.storage.local.
     *
     * @param {boolean} forceRefresh - Принудительное обновление кеша
     * @returns {Promise<Array>}
     */
    async fetchStores(forceRefresh = false) {
        if (!forceRefresh) {
            const cached = await chrome.storage.local.get(['stores', 'stores_updated_at']);
            if (cached.stores && cached.stores_updated_at) {
                const age = Date.now() - cached.stores_updated_at;
                if (age < CASHBACK_CONFIG.STORES_CACHE_TTL) {
                    return cached.stores;
                }
            }
        }

        const stores = await this.request('/stores');
        await chrome.storage.local.set({
            stores: stores,
            stores_updated_at: Date.now(),
        });
        return stores;
    },

    /**
     * Получить профиль и баланс текущего пользователя.
     *
     * @returns {Promise<Object>}
     */
    async fetchProfile() {
        return this.request('/me');
    },

    /**
     * Получить транзакции пользователя.
     *
     * @param {number} page     - Номер страницы
     * @param {number} perPage  - Записей на странице
     * @returns {Promise<Object>}
     */
    async fetchTransactions(page = 1, perPage = 5) {
        return this.request('/me/transactions', { page, per_page: perPage });
    },

    /**
     * Активировать кэшбэк для товара.
     *
     * @param {number} productId - ID товара WooCommerce
     * @returns {Promise<Object>} { redirect_url, click_id, expires_at }
     */
    async activateCashback(productId) {
        return this.request('/activate', { product_id: productId }, 'POST');
    },

    /**
     * Проверить статус активации для домена.
     *
     * @param {string} domain - Домен магазина
     * @returns {Promise<Object>} { activated, activated_at, expires_at }
     */
    async checkSessionStatus(domain) {
        return this.request('/session-status', { domain });
    },

    /**
     * Получить активные промокоды магазина для popup.
     * Public endpoint, не требует авторизации. Сервер кеширует ответ
     * в transient на 1 час с инвалидацией по cron-fetch / product-save.
     *
     * @param {number} productId - ID товара WooCommerce
     * @returns {Promise<{product_id:number, items:Array, total:number}>}
     */
    async fetchPromocodes(productId) {
        return this.request('/promocodes', { product_id: productId });
    },

    /**
     * Найти магазин по домену из кешированного списка.
     *
     * @param {string} domain - Домен для поиска
     * @returns {Promise<Object|null>}
     */
    async findStoreByDomain(domain) {
        const stores = await this.fetchStores();
        if (!stores || !stores.length) return null;

        // Удаляем www. для унификации
        const cleanDomain = domain.replace(/^www\./i, '');

        return stores.find(store => {
            // Убираем протокол (https://, http://) и www. из домена магазина
            const storeDomain = store.domain
                .replace(/^https?:\/\//i, '')
                .replace(/^www\./i, '')
                .replace(/\/.*$/, ''); // убираем путь, если есть
            return cleanDomain === storeDomain || cleanDomain.endsWith('.' + storeDomain);
        }) || null;
    },
};

/**
 * Ошибки API.
 */
class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

class AuthError extends ApiError {
    constructor(message) {
        super(message, 401);
        this.name = 'AuthError';
    }
}

class RateLimitError extends ApiError {
    constructor(message) {
        super(message, 429);
        this.name = 'RateLimitError';
    }
}

/**
 * Проверка redirect URL перед навигацией.
 * Блокирует javascript:, data: и другие небезопасные протоколы.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isValidRedirectUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}
