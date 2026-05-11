/**
 * Content script для браузерного расширения кэшбэк-сервиса.
 *
 * Показывает уведомление о кэшбэке на страницах магазинов-партнёров.
 * Два пути получения данных (для надёжности):
 *   1. Service Worker пушит SHOW_NOTIFICATION после определения магазина
 *   2. Content script сам запрашивает GET_STORE_INFO (fallback)
 *
 * Детекция competing: проверяет document.referrer и URL-параметры на признаки
 * конкурирующих affiliate-редиректов (индустриальный стандарт — Honey, Rakuten).
 *
 * Уведомление рендерится через Shadow DOM (изоляция от CSS сайта).
 */

(function () {
  'use strict';

  // Защита от повторной инжекции
  if (window.__cashbackExtInjected) return;
  window.__cashbackExtInjected = true;

  const domain = window.location.hostname.replace(/^www\./i, '');

  // Не показываем на нашем собственном сайте — кроме страницы активации (?cashback_go=1)
  try {
    const siteHost = new URL(CASHBACK_CONFIG.SITE_URL).hostname.replace(/^www\./i, '');
    if (domain === siteHost) {
      const params = new URLSearchParams(window.location.search);
      if (params.get('cashback_go') === '1' && params.get('click_id')) {
        // Страница активации: устанавливаем мост страница ↔ service worker
        setupActivationPageBridge();
      } else {
        // Страница магазина/товара на нашем сайте:
        // перехватываем клики по кнопкам кэшбэка, чтобы активировать через расширение
        // без промежуточной страницы и задержки редиректа.
        setupSiteButtonInterceptor();
      }
      return; // уведомления на своём сайте не показываем
    }
  } catch {
    // ignore
  }

  // ─── Перехват кликов по кнопкам кэшбэка на нашем сайте ───
  //
  // Когда пользователь нажимает «Получить кэшбэк» на карточке или странице товара,
  // перехватываем клик, активируем кэшбэк через service worker и открываем
  // партнёрский URL напрямую — без промежуточной страницы и задержки.
  // Если расширение не работает или пользователь не авторизован — fallback на обычную ссылку.

  function setupSiteButtonInterceptor() {
    // Проверяем авторизацию один раз при загрузке страницы.
    // Если пользователь не авторизован — не перехватываем клики,
    // чтобы сработала модалка предупреждения для гостей (affiliate-guest-warning.js).
    let isAuthenticated = null; // null = ещё не проверено

    chrome.runtime
      .sendMessage({ type: 'CHECK_AUTH' })
      .then(function (response) {
        isAuthenticated = !!(response && response.authenticated);
      })
      .catch(function () {
        isAuthenticated = false;
      });

    document.addEventListener(
      'click',
      function (e) {
        // Ищем ближайшую ссылку с data-product-id (кнопка «Получить кэшбэк»)
        const btn = e.target.closest('[data-product-id]');
        if (!btn) return;

        const productId = parseInt(btn.getAttribute('data-product-id'), 10);
        if (!productId) return;

        // Перехватываем все кнопки с data-product-id на нашем сайте
        // (и новые с cashback_click=, и старые с прямым affiliate URL)
        const href = btn.getAttribute('href') || '';
        if (!href) return;

        // Неавторизованные: не перехватываем, пусть сайт покажет модалку предупреждения
        if (isAuthenticated === false) return;

        // Авторизация ещё не проверена (CHECK_AUTH не успел ответить): тоже пропускаем,
        // сервер сам обработает клик корректно через ?cashback_click=
        if (isAuthenticated === null) return;

        e.preventDefault();
        e.stopImmediatePropagation(); // останавливаем и WoodMart-обработчики

        // Кнопка остаётся без изменений — никаких "...", смены размеров или текста.
        // Пользователь видит только стандартный CSS-эффект клика темы.

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
        // Service worker не ответил — редирект произойдёт через fallback таймер
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

  // Не показываем на служебных страницах
  const proto = window.location.protocol;
  if (proto !== 'http:' && proto !== 'https:') return;

  let notificationShown = false;
  let currentNotificationHost = null; // Ссылка на DOM-элемент уведомления

  /**
   * Удаляет текущее уведомление из DOM.
   * Нужно для замены обычного уведомления на competing.
   */
  function removeExistingNotification() {
    if (currentNotificationHost) {
      currentNotificationHost.remove();
      currentNotificationHost = null;
    }
  }

  // ─── Путь 1: Получение push от Service Worker ───

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SHOW_NOTIFICATION' && message.store) {
      // Если для магазина выбрано «Не показывать» — не показываем ничего,
      // включая competing. Пользователь увидит красную иконку и статус в popup.
      if (message.store.popup_mode === 'hide') return;

      // Competing-уведомления всегда показываются, даже если обычное уже отображено.
      // Это критично: пользователь ДОЛЖЕН узнать что кэшбэк перебит.
      if (message.notification_type === 'competing') {
        removeExistingNotification();
        notificationShown = false;
      }
      if (!notificationShown) {
        handleShowNotification(
          message.store,
          message.isAuthenticated,
          message.notification_type || 'activate',
        );
      }
    }
  });

  // ─── Повторная проверка при возврате на вкладку ───
  //
  // Когда пользователь переключается обратно на вкладку магазина после
  // посещения конкурирующего кэшбэк-сервиса, проверяем состояние заново.
  // Service worker уже мог обнаружить competing через webNavigation
  // в другой вкладке и обновить состояние — нужно подхватить это.

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_STORE_INFO',
        domain,
      });

      if (!response || !response.store) return;

      // Если состояние стало competing — показать уведомление
      // (только если для магазина не выбрано «Не показывать»)
      if (response.state === 'competing' && response.store.popup_mode !== 'hide') {
        removeExistingNotification();
        notificationShown = false;
        handleShowNotification(response.store, true, 'competing');
      }
    } catch {
      // Ошибка — игнорируем
    }
  });

  // ─── Путь 2: Самостоятельный запрос (fallback) ───

  setTimeout(async () => {
    if (notificationShown) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_STORE_INFO',
        domain,
      });

      if (!response || !response.store) {
        return;
      }

      // Кэшбэк активен — проверяем на competing через referrer/URL/affiliate-параметры,
      // но ТОЛЬКО если активация не свежая (> 20 сек).
      // Свежая активация = пользователь только что пришёл через наш affiliate redirect,
      // referrer будет ad.admitad.com / epn.bz / другая CPA-сеть — это НЕ конкурент.
      if (response.state === 'active' || response.activated) {
        const activationAge =
          response.activation && response.activation.activated_at
            ? Date.now() - new Date(response.activation.activated_at).getTime()
            : Infinity;

        if (activationAge > 20000) {
          // Метод 1: referrer / URL-анализ (существующий)
          if (detectCompetingClick()) {
            chrome.runtime.sendMessage({ type: 'COMPETING_DETECTED', domain }).catch(() => {});
            return;
          }
          // Метод 2: сравнение affiliate-параметров через SW
          // Ловит случай когда чужой сервис даёт прямую ссылку на магазин
          // с другим tagtag_uid/subid — без redirect через свой домен.
          try {
            const paramsCheck = await chrome.runtime.sendMessage({
              type: 'CHECK_AFFILIATE_PARAMS',
              domain,
              url: window.location.href,
            });
            if (paramsCheck && paramsCheck.competing) {
              chrome.runtime.sendMessage({ type: 'COMPETING_DETECTED', domain }).catch(() => {});
              return;
            }
          } catch {
            // SW не ответил — игнорируем
          }
        }
        // Не показываем стандартное уведомление при активном кэшбэке
        return;
      }

      // Состояние competing — уведомление уже показано фоновым скриптом
      if (response.state === 'competing') {
        return;
      }

      // Если администратор выбрал «Не показывать» — уведомление не выводим
      if (response.store.popup_mode === 'hide') {
        return;
      }

      // idle или expired — обычное уведомление "Активировать кэшбэк"
      let isAuthenticated = false;
      try {
        const authResponse = await chrome.runtime.sendMessage({ type: 'CHECK_AUTH' });
        isAuthenticated = authResponse && authResponse.authenticated;
      } catch {
        // Покажем уведомление для неавторизованного
      }

      handleShowNotification(response.store, isAuthenticated, 'activate');
    } catch {
      // Ошибка fallback-запроса — игнорируем
    }
  }, CASHBACK_CONFIG.NOTIFICATION_DELAY);

  // ─── Детекция конкурирующего affiliate-клика ───
  //
  // Стандартный метод индустрии (Honey, Rakuten, Letyshops):
  //   1. Проверка document.referrer — если пришли с известного конкурирующего сервиса
  //      или через URL с типичными паттернами affiliate-редиректов → competing.
  //   2. Проверка URL-параметров текущей страницы — affiliate-теги чужих сетей.
  //
  // Вызывается ТОЛЬКО при наличии активной сессии (state === 'active').

  function detectCompetingClick() {
    const referrer = document.referrer;
    const currentUrl = window.location.href;

    // Известные конкурирующие кэшбэк-сервисы и affiliate-сети
    const COMPETING_DOMAINS = [
      // Российские кэшбэк-сервисы
      'letyshops.com',
      'megabonus.com',
      'kopikot.ru',
      'smarty.sale',
      'cashback.ru',
      'giftd.tech',
      'skidka.ru',
      'backit.me',
      'epn.bz',
      'cashbackoff.ru',
      'switchback.ru',
      'promokodus.com',
      // Affiliate-сети (не наши)
      'admitad.com',
      'cityads.ru',
      'actionpay.ru',
      'leads.su',
      'cpa.ru',
      'where.ru',
      // Глобальные кэшбэк и affiliate
      'honey.com',
      'joinhoney.com',
      'awin.com',
      'awinmid.com',
      'tradedoubler.com',
      'rakuten.com',
      'linksynergy.com',
      'commissionjunction.com',
      'cj.com',
      'shareasale.com',
      'impact.com',
      'partnerize.com',
    ];

    // Паттерны путей, характерные для affiliate-редиректов
    const REDIRECT_PATH_PATTERNS = [
      '/goto/',
      '/r/',
      '/click/',
      '/track/',
      '/refer/',
      '/redirect/',
      '/go/',
      '/out/',
      '/visit/',
      '/away/',
    ];

    // URL-параметры, уникальные для чужих affiliate-сетей
    const COMPETING_URL_PARAMS = [
      'awinmid',
      'awinaffid',
      'awc', // AWIN
      'admitad_uid', // Admitad (чужой publisher)
      'actionpay', // ActionPay
      'cityads_source', // CityAds
      'letyshops_uid',
      'lts_uid', // Letyshops
      'mb_uid', // Megabonus
      'kopikot_uid', // Kopikot
      'cj_aid',
      'cjevent', // Commission Junction
      'irclickid', // Impact Radius
      'tduid', // TradeDoubler
      'ranMID',
      'ranEAID',
      'ranSiteID', // Rakuten
      'sscid', // ShareASale
    ];

    // 1. Анализ document.referrer
    if (referrer) {
      try {
        const ref = new URL(referrer);
        const refHost = ref.hostname.replace(/^www\./i, '').toLowerCase();
        const refPath = ref.pathname;
        const ourHost = new URL(CASHBACK_CONFIG.SITE_URL).hostname.replace(/^www\./i, '');

        // Не конкурент если пришли с нашего сайта или с самого магазина
        if (refHost !== ourHost && refHost !== domain) {
          // Точное совпадение с известным конкурирующим доменом
          if (
            COMPETING_DOMAINS.some(
              (d) => refHost === d.toLowerCase() || refHost.endsWith('.' + d.toLowerCase()),
            )
          ) {
            return true;
          }
          // Обобщённый признак: путь содержит паттерн affiliate-редиректа
          if (REDIRECT_PATH_PATTERNS.some((p) => refPath.includes(p))) {
            return true;
          }
        }
      } catch {
        /* невалидный referrer — игнорируем */
      }
    }

    // 2. Анализ URL-параметров текущей страницы
    try {
      const params = new URL(currentUrl).searchParams;
      if (COMPETING_URL_PARAMS.some((p) => params.has(p))) {
        return true;
      }
    } catch {
      /* невалидный URL — игнорируем */
    }

    return false;
  }

  // ─── Общая логика показа уведомления ───

  async function handleShowNotification(store, isAuthenticated, notificationType) {
    if (notificationShown) return;

    const type = notificationType || 'activate';

    // Для competing-уведомлений используем отдельный ключ dismiss
    // (не блокируется предыдущим dismiss обычного уведомления)
    const dismissKey =
      type === 'competing' ? `competing_dismissed_${domain}` : `dismissed_${domain}`;

    try {
      const dismissed = await chrome.storage.session.get(dismissKey);
      if (dismissed[dismissKey]) {
        return;
      }
    } catch {
      // Покажем всё равно
    }

    notificationShown = true;
    showNotification(store, domain, !!isAuthenticated, type);
  }

  // ─── Создание и показ уведомления через Shadow DOM ───

  function showNotification(store, domain, isAuthenticated, notificationType) {
    const storeName = store.store_name || domain;
    const cashbackLabel = store.cashback_label || 'Кэшбэк';
    const cashbackValue = store.cashback_value || '';
    const isCompeting = notificationType === 'competing';

    // Контейнер-хост для Shadow DOM
    const host = document.createElement('div');
    host.setAttribute(
      'style',
      'all:initial !important;' +
        'position:fixed !important;' +
        'top:20px !important;' +
        'right:20px !important;' +
        'z-index:2147483647 !important;' +
        'display:block !important;' +
        'visibility:visible !important;' +
        'opacity:1 !important;' +
        'width:auto !important;' +
        'height:auto !important;' +
        'pointer-events:auto !important;',
    );

    const shadow = host.attachShadow({ mode: 'closed' });

    // Стили
    const style = document.createElement('style');
    style.textContent = getNotificationStyles();
    shadow.appendChild(style);

    // Уведомление
    const notification = document.createElement('div');
    notification.className = isCompeting ? 'cb-notification competing' : 'cb-notification';

    const safeProductId = parseInt(store.product_id, 10) || 0;

    // ── Содержимое в зависимости от типа ──
    let iconHtml, titleHtml, valueHtml, actionsHtml;
    let subtitleText = '';

    if (isCompeting) {
      // Competing: кэшбэк был сброшен чужим сайтом
      iconHtml = '&#9888;&#65039;';
      titleHtml = escapeHtml(storeName);
      valueHtml =
        'Вы перешли через другого партнёра, чтобы получить кэшбэк у нас, активируйте его снова.';
      actionsHtml = isAuthenticated
        ? `<button class="cb-btn cb-btn-activate competing" data-product-id="${safeProductId}">Активировать снова</button>`
        : `<button class="cb-btn cb-btn-login">Войти и получить кэшбэк</button>`;
    } else {
      // Стандартное: предложение активировать кэшбэк
      iconHtml = '&#127873;';
      titleHtml = escapeHtml(storeName);
      valueHtml = escapeHtml(cashbackLabel) + ' ' + escapeHtml(cashbackValue);
      subtitleText = isAuthenticated
        ? 'Активируйте для получения возврата'
        : 'Войдите для получения кэшбэка';
      actionsHtml = isAuthenticated
        ? `<button class="cb-btn cb-btn-activate" data-product-id="${safeProductId}">Активировать кэшбэк</button>`
        : `<button class="cb-btn cb-btn-login">Войти и получить кэшбэк</button>`;
    }

    notification.innerHTML =
      '<div class="cb-header">' +
      '<span class="cb-brand">' +
      '<img src="' +
      chrome.runtime.getURL('icons/savello-club-logo.svg') +
      '" width="32" height="32" style="vertical-align:middle">' +
      ' Кэшбэк Сервис Савелло Клуб' +
      '</span>' +
      '<button class="cb-close" title="Закрыть">&times;</button>' +
      '</div>' +
      '<div class="cb-body">' +
      '<span class="cb-icon">' +
      iconHtml +
      '</span>' +
      '<div class="cb-info">' +
      '<span class="cb-title">' +
      titleHtml +
      '</span>' +
      '<span class="cb-value' +
      (isCompeting ? ' competing' : '') +
      '">' +
      (isCompeting ? escapeHtml(valueHtml) : valueHtml) +
      '</span>' +
      (subtitleText ? '<span class="cb-subtitle">' + subtitleText + '</span>' : '') +
      '</div>' +
      '</div>' +
      '<div class="cb-actions">' +
      actionsHtml +
      '</div>';

    shadow.appendChild(notification);

    // Сохраняем ссылку для возможной замены на competing-уведомление
    currentNotificationHost = host;

    // Вставляем в DOM
    const target = document.body || document.documentElement;
    target.appendChild(host);

    // Анимация появления
    requestAnimationFrame(() => {
      notification.classList.add('visible');
    });

    // ─── Обработчики ───

    shadow.querySelector('.cb-close').addEventListener('click', () => {
      dismissNotification(host, notification, domain, notificationType);
    });

    const loginBtn = shadow.querySelector('.cb-btn-login');
    if (loginBtn) {
      loginBtn.addEventListener('click', () => {
        window.open(CASHBACK_CONFIG.LOGIN_URL, '_blank');
        dismissNotification(host, notification, domain, notificationType);
      });
    }

    const activateBtn = shadow.querySelector('.cb-btn-activate');
    if (activateBtn) {
      activateBtn.addEventListener('click', async () => {
        const productId = parseInt(activateBtn.dataset.productId, 10);
        if (!productId || activateBtn.disabled) return;

        activateBtn.disabled = true;

        try {
          const result = await chrome.runtime.sendMessage({
            type: 'ACTIVATE',
            productId,
            domain,
          });

          if (result && result.error) {
            throw new Error(result.error);
          }

          notification.classList.remove('competing');
          notification.classList.add('activated');

          // Redirect через партнёрскую ссылку для установки tracking cookies CPA-сети.
          // Используем activation_page_url (наш сайт → affiliate URL), чтобы
          // CPA-сеть видела корректный Referer.
          // Если activation_page_url нет — redirect_url напрямую.
          const redirectTo =
            result && result.activation_page_url && isValidRedirectUrl(result.activation_page_url)
              ? result.activation_page_url
              : result && result.redirect_url && isValidRedirectUrl(result.redirect_url)
                ? result.redirect_url
                : null;

          if (redirectTo) {
            setTimeout(() => {
              window.location.href = redirectTo;
            }, 800);
          } else {
            // Нет URL для redirect — просто показываем успех и закрываем
            setTimeout(
              () => dismissNotification(host, notification, domain, notificationType),
              3000,
            );
          }
        } catch (e) {
          activateBtn.disabled = false;
        }
      });
    }
  }

  // ─── Скрытие уведомления ───

  function dismissNotification(host, notification, domain, notificationType) {
    notification.classList.remove('visible');
    notification.classList.add('hiding');

    const dismissKey =
      notificationType === 'competing' ? `competing_dismissed_${domain}` : `dismissed_${domain}`;

    chrome.storage.session.set({ [dismissKey]: true }).catch(() => {});

    setTimeout(() => {
      host.remove();
      if (currentNotificationHost === host) {
        currentNotificationHost = null;
      }
    }, 400);
  }

  // ─── Стили (инжектируются в Shadow DOM) ───

  function getNotificationStyles() {
    return `
            .cb-notification {
                width: 360px;
                max-width: calc(100vw - 40px);
                background: #ffffff;
                border: 1px solid rgba(231, 76, 60, 0.4);
                border-radius: 14px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15),
                            0 0 0 1px rgba(0, 0, 0, 0.05);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 14px;
                color: #242424;
                overflow: hidden;
                transform: translateY(-20px);
                opacity: 0;
                transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1),
                            opacity 0.3s ease;
            }
            .cb-notification.visible {
                transform: translateY(0);
                opacity: 1;
            }
            .cb-notification.hiding {
                transform: translateY(-20px);
                opacity: 0;
            }
            .cb-notification.activated {
                border-color: rgba(39, 174, 96, 0.4);
            }
            .cb-notification.activated .cb-value {
                color: #27ae60;
            }
            /* Competing: оранжевая рамка */
            .cb-notification.competing {
                border-color: rgba(243, 156, 18, 0.5);
            }
            .cb-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 14px 0;
            }
            .cb-brand {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                color: #909090;
                font-weight: 500;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .cb-brand-icon { font-size: 14px; }
            .cb-close {
                width: 24px; height: 24px;
                display: flex; align-items: center; justify-content: center;
                background: none; border: none;
                color: #909090; font-size: 18px;
                cursor: pointer; border-radius: 4px;
                transition: all 0.2s;
                line-height: 1; padding: 0;
            }
            .cb-close:hover {
                background: rgba(0, 0, 0, 0.06);
                color: #242424;
            }
            .cb-body {
                padding: 12px 14px;
                display: flex; align-items: center; gap: 12px;
            }
            .cb-icon {
                font-size: 36px; flex-shrink: 0; line-height: 1;
            }
            .cb-info {
                display: flex; flex-direction: column; gap: 2px; flex: 1;
            }
            .cb-title {
                font-size: 15px; font-weight: 600; color: #242424;
            }
            .cb-value {
                font-size: 18px; font-weight: 700; color: #e74c3c;
            }
            /* Competing: оранжево-красный текст, как в popup расширения */
            .cb-value.competing {
                font-size: 15px;
                font-weight: 600;
                color: #f35212;
                line-height: 1.4;
            }
            .cb-subtitle {
                font-size: 12px; color: #707070;
            }
            .cb-actions { padding: 0 14px 14px; }
            .cb-btn {
                display: flex; align-items: center; justify-content: center;
                width: 100%; padding: 11px 16px;
                color: #fff; border: none; border-radius: 10px;
                font-size: 14px; font-weight: 600;
                cursor: pointer; transition: all 0.2s ease;
                font-family: inherit; box-sizing: border-box;
            }
            .cb-btn-activate {
                background: linear-gradient(135deg, #e74c3c, #c0392b);
            }
            .cb-btn-activate:hover {
                background: linear-gradient(135deg, #c0392b, #a93226);
                transform: translateY(-1px);
            }
            /* Competing: оранжевая кнопка "Активировать снова" */
            .cb-btn-activate.competing {
                background: linear-gradient(135deg, #f39c12, #d68910);
            }
            .cb-btn-activate.competing:hover {
                background: linear-gradient(135deg, #d68910, #b7770d);
                transform: translateY(-1px);
            }
            .cb-btn-login {
                background: #83b735;
            }
            .cb-btn-login:hover {
                background: #74a32f;
                transform: translateY(-1px);
            }
            .cb-btn:active { transform: translateY(0); }
            .cb-btn:disabled {
                opacity: 0.6; cursor: not-allowed; transform: none;
            }
            .cb-btn.success {
                background: linear-gradient(135deg, #27ae60, #1e8449);
            }
            @media (max-width: 420px) {
                .cb-notification { width: auto; max-width: none; }
            }
        `;
  }

  // ─── Утилиты ───

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

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
