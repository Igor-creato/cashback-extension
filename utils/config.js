/**
 * Конфигурация браузерного расширения кэшбэк-сервиса.
 *
 * ВАЖНО: Замените SITE_URL на реальный URL вашего WordPress-сайта.
 * БЕЗОПАСНОСТЬ: В продакшене обязательно используйте HTTPS.
 *   HTTP допустим ТОЛЬКО для локальной разработки (localhost).
 *   Также замените host_permissions в manifest.json на https://your-domain.com/*
 */

const CASHBACK_CONFIG = {
  // URL WordPress-сайта (без trailing slash)
  // ПРОДАКШЕН: заменить на https://your-domain.com
  SITE_URL: 'https://savelloclub.ru',

  // Базовый URL REST API
  get API_BASE() {
    return `${this.SITE_URL}/wp-json/cashback/v1`;
  },

  // URL страницы входа
  get LOGIN_URL() {
    return `${this.SITE_URL}/my-account/`;
  },

  // URL каталога магазинов — главная страница сайта, где смонтирован
  // основной каталог витрины с переходом на товары/магазины (а не /shop/
  // WC-архив, который пользователь не использует как лендинг).
  get STORES_URL() {
    return `${this.SITE_URL}/`;
  },

  // URL страницы вывода кэшбэка
  get WITHDRAWAL_URL() {
    return `${this.SITE_URL}/my-account/cashback-withdrawal/`;
  },

  // Политика обработки персональных данных.
  // TODO Савелло: дополнить раздел о расширении (какие данные читает локально,
  // что уходит на сервер — product_id и click_id, что НЕ передаётся —
  // история посещений). Текущая редакция документа покрывает кэшбэк-сервис
  // в целом, но не упоминает браузерное расширение явно.
  get PRIVACY_POLICY_URL() {
    return `${this.SITE_URL}/pd-policy/`;
  },

  // TTL кеша списка магазинов (10 минут в мс)
  // Короткий TTL гарантирует быстрое применение изменений popup_mode и других настроек
  STORES_CACHE_TTL: 10 * 60 * 1000,

  // TTL активации кэшбэка (30 минут в мс)
  ACTIVATION_TTL: 30 * 60 * 1000,

  // Задержка показа уведомления на странице (мс)
  NOTIFICATION_DELAY: 2000,

  // Валюта по умолчанию
  CURRENCY_SYMBOL: '₽',
};

// Для content scripts (не ES modules)
if (typeof window !== 'undefined') {
  window.CASHBACK_CONFIG = CASHBACK_CONFIG;
}
