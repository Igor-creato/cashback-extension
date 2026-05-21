/**
 * Content script для страниц savelloclub.ru.
 *
 * Делает ровно две вещи:
 *
 *   1. Перехватывает клик по кнопке «Получить кэшбэк» на карточках/страницах
 *      товаров — активирует кэшбэк через service worker и открывает партнёрский
 *      URL без промежуточной страницы и задержки редиректа. Это легитимная
 *      пользовательская активация (новый заход через Савелло, не перебитие
 *      существующей чужой сессии).
 *
 *   2. На странице активации (?cashback_go=1&click_id=...) уведомляет SW
 *      о произошедшей серверной активации, чтобы расширение подсветило
 *      следующую вкладку магазина зелёной иконкой.
 *
 * Расширение НЕ инжектирует content scripts на страницы магазинов и не
 * пытается определять, через какого партнёра пользователь туда попал.
 * Это сделано осознанно: на странице магазина нет надёжного способа
 * отличить органический заход от чужого партнёрского, а одно-кликовое
 * перебитие чужой сессии = фрод по офертам Gdeslon/AdvCake.
 */

(function () {
  'use strict';

  // Защита от повторной инжекции
  if (window.__cashbackExtInjected) return;
  window.__cashbackExtInjected = true;

  const domain = window.location.hostname.replace(/^www\./i, '');

  // Лишний предохранитель: статически зарегистрированы только на savelloclub.ru,
  // но проверяем явно на случай локальной разработки или редкого www-варианта.
  let siteHost;
  try {
    siteHost = new URL(CASHBACK_CONFIG.SITE_URL).hostname.replace(/^www\./i, '');
  } catch {
    return;
  }
  if (domain !== siteHost) return;

  const params = new URLSearchParams(window.location.search);

  if (params.get('cashback_go') === '1' && params.get('click_id')) {
    // Страница активации: уведомляем SW о произошедшем server-side click.
    setupActivationPageBridge();
  } else {
    // Любая другая страница на нашем сайте: перехватываем клики по
    // кнопкам активации кэшбэка, чтобы не дожидаться промежуточной страницы.
    setupSiteButtonInterceptor();
  }

  // ─── Перехват кликов по кнопкам «Получить кэшбэк» ───
  //
  // Перехватываем ТОЛЬКО если выполнены ВСЕ условия:
  //   - Пользователь авторизован в savelloclub.ru
  //   - Пользователь дал согласие на работу расширения (онбординг пройден)
  //
  // Иначе клик проходит штатным путём через серверный редирект
  // (PHP-обработчик ?cashback_click=). Никаких всплывающих окон,
  // принуждающих пройти онбординг через клик по кнопке — это раздражает
  // и нарушает принцип «активация только по явному согласию».

  function setupSiteButtonInterceptor() {
    let isAuthenticated = null; // null = ещё не проверено
    let hasConsent      = null; // null = ещё не проверено

    chrome.runtime
      .sendMessage({ type: 'CHECK_AUTH' })
      .then(function (response) {
        isAuthenticated = !!(response && response.authenticated);
      })
      .catch(function () {
        isAuthenticated = false;
      });

    chrome.runtime
      .sendMessage({ type: 'CHECK_CONSENT' })
      .then(function (response) {
        hasConsent = !!(response && response.consent);
      })
      .catch(function () {
        hasConsent = false;
      });

    document.addEventListener(
      'click',
      function (e) {
        // Ищем кнопку «Получить кэшбэк». Плагин гарантированно ставит ОБА
        // атрибута data-product-id и data-product-url только на ней
        // (wc-affiliate-url-params.php: modify_single_product_button и
        // add_product_id_to_link). Эта пара отсекает WoodMart wishlist
        // (`.wd-wishlist-btn a` — только data-product-id) и иконки купонов
        // (`<span data-product-id>` — не <a>).
        const btn = e.target.closest('a[data-product-id][data-product-url]');
        if (!btn) return;

        const productId = parseInt(btn.getAttribute('data-product-id'), 10);
        if (!productId) return;

        const href = btn.getAttribute('href') || '';
        if (!href) return;

        // Не перехватываем пока не убедились, что и авторизация, и consent есть.
        if (isAuthenticated !== true || hasConsent !== true) return;

        e.preventDefault();
        e.stopImmediatePropagation(); // останавливаем и WoodMart-обработчики

        chrome.runtime
          .sendMessage({
            type: 'ACTIVATE',
            productId: productId,
            domain: null, // SW извлечёт домен из result.domain
          })
          .then(function (result) {
            if (result && !result.error) {
              // Открываем через страницу активации (5-секундный счётчик),
              // fallback на прямой affiliate URL если activation_page_url нет.
              var target =
                result.activation_page_url && isValidRedirectUrl(result.activation_page_url)
                  ? result.activation_page_url
                  : result.redirect_url;
              if (target && isValidRedirectUrl(target)) {
                window.open(target, '_blank');
              } else {
                window.open(href, '_blank');
              }
            } else {
              // Fallback: открываем через исходную ссылку (сервер залогирует клик)
              window.open(href, '_blank');
            }
          })
          .catch(function () {
            window.open(href, '_blank');
          });
      },
      true,
    ); // capture: перехватываем до срабатывания href
  }

  // ─── Мост страницы активации → service worker ───
  //
  // Страница записывает данные в data-cb-activation ДО наступления document_idle,
  // поэтому content script всегда находит их в DOM без зависимости от событий.

  function setupActivationPageBridge() {
    async function processActivation(cbDomain, cbClickId) {
      try {
        await chrome.runtime.sendMessage({
          type: 'SITE_ACTIVATED',
          domain: cbDomain,
          click_id: cbClickId,
        });
      } catch {
        // SW не ответил — серверный редирект через cb_activation cookie
        // и chrome.cookies fallback всё равно подсветят иконку зелёным.
      }
      // Сигнализируем странице: можно редиректить немедленно
      document.dispatchEvent(new CustomEvent('cashback:site:confirmed'));
    }

    // Путь 1 (основной): данные уже записаны в DOM до document_idle
    const raw = document.documentElement.getAttribute('data-cb-activation');
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data.domain && data.click_id) {
          processActivation(data.domain, data.click_id);
          return;
        }
      } catch {
        /* невалидный JSON — игнорируем */
      }
    }

    // Путь 2 (резервный): слушаем событие на случай нестандартного порядка загрузки
    document.addEventListener('cashback:site:activate', function (event) {
      processActivation(event.detail.domain, event.detail.click_id);
    });
  }

  // ─── Утилиты ───

  /**
   * Проверка redirect URL перед навигацией.
   * Блокирует javascript:, data: и другие небезопасные протоколы.
   */
  function isValidRedirectUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
})();
