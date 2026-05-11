/**
 * Offscreen document для выполнения fetch-запросов.
 *
 * Воркэраунд для Яндекс.Браузера: fetch, инициированный из обработчиков
 * service worker'а (onMessage / onAlarm / onInstalled), зависает на TCP до
 * полного timeout (60 сек). Тот же запрос из контекста обычной HTML-страницы
 * (включая offscreen document) работает нормально. В Chrome/Edge оба пути
 * работают — фикс transparent.
 *
 * Service worker отправляет {type:'OFFSCREEN_FETCH', url, options}, offscreen
 * выполняет fetch и возвращает {ok, status, statusText, contentType, text}
 * либо {ok:false, error}.
 *
 * Безопасность: URL allowlist гарантирует, что offscreen не может быть
 * использован для проксирования произвольных запросов с auth-cookies
 * (defense-in-depth — sendMessage и так ограничен нашим extension'ом).
 */

// Allowlist хостов для fetch. Подгружается из config.js в SW и передаётся в URL;
// здесь сверяем хост, потому что offscreen.html не подключает config.js.
const ALLOWED_HOST_SUFFIX = '.autmatization-bot.ru';
const ALLOWED_HOSTS_EXACT = ['mybestestsite.autmatization-bot.ru'];

function isAllowedUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== 'https:') return false;
        if (ALLOWED_HOSTS_EXACT.includes(u.hostname)) return true;
        return u.hostname.endsWith(ALLOWED_HOST_SUFFIX);
    } catch {
        return false;
    }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== 'OFFSCREEN_FETCH') {
        return false;
    }

    if (!isAllowedUrl(message.url)) {
        sendResponse({ ok: false, error: 'URL not in allowlist' });
        return true;
    }

    (async function () {
        try {
            const response = await fetch(message.url, message.options || {});
            const text = await response.text();
            sendResponse({
                ok:          true,
                status:      response.status,
                statusText:  response.statusText,
                contentType: response.headers.get('content-type') || '',
                text:        text,
            });
        } catch (e) {
            sendResponse({
                ok:    false,
                error: (e && e.message) || 'fetch failed',
            });
        }
    })();

    return true; // async sendResponse
});
