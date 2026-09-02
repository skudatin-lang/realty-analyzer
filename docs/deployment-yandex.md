# Развёртывание в Yandex Cloud — пошагово

Ниже путь через веб-консоль. Названия кнопок могут немного отличаться.

## 1. Подготовить каталог и сервисный аккаунт

1. Откройте Yandex Cloud Console и выберите существующий каталог или создайте новый.
2. Откройте **Сервисные аккаунты → Создать**. Имя: `realty-analyzer-function`.
3. Пока не выдавайте широкие роли на весь каталог.

## 2. Положить ключ в Lockbox

1. Откройте **Lockbox → Создать секрет**.
2. Имя: `realty-analyzer-ai`.
3. Добавьте пару: ключ `PROXYAPI_KEY`, значение — ваш ProxyAPI key.
4. На странице секрета откройте **Права доступа** и выдайте сервисному аккаунту только роль чтения payload секрета (`lockbox.payloadViewer`).

## 3. Создать функцию

1. Откройте **Cloud Functions → Создать функцию**, runtime Node.js 22 (или актуальный поддерживаемый Node.js ≥20).
2. Загрузите ZIP всего репозитория либо backend вместе с `schemas/` и `prompts/`; entrypoint: `backend/src/index.handler`.
3. Выберите сервисный аккаунт `realty-analyzer-function`.
4. Память: 512 МБ; timeout: 90 секунд.
5. Добавьте обычные переменные окружения:
   - `AI_PROVIDER=proxyapi-openrouter`
   - `AI_BASE_URL=https://api.proxyapi.ru/openrouter/v1`
   - `VISION_MODEL=<проверенная vision-модель>`
   - `ANALYSIS_MODEL=<выбранная text/reasoning-модель>`
   - `ALLOWED_ORIGINS=https://ВАШ_ЛОГИН.github.io`
   - `RATE_LIMIT_PER_MINUTE=20`
6. Подключите Lockbox secret к переменной `PROXYAPI_KEY` (не копируйте значение как обычную переменную).

## 4. Опубликовать HTTP API

Предпочтительно создать API Gateway с маршрутами GET/POST/OPTIONS `/api/{proxy+}` к функции. Gateway даёт единый HTTPS URL, CORS routing и возможность quota/throttling. Публичный прямой invoke URL функции допустим только если в вашем интерфейсе он поддерживает нужные методы, размер multipart и CORS.

Скопируйте HTTPS URL Gateway и замените `https://YOUR_FUNCTION_ID.apigw.yandexcloud.net` в `assets/js/config.js`.

## 5. Smoke test

Откройте в браузере `ВАШ_URL/api/health`. Ожидается:

```json
{"ok":true,"providerConfigured":true}
```

Затем опубликуйте frontend и попробуйте один реальный скриншот. Это обязательная проверка vision-модели.

## 6. GitHub Pages

1. Создайте пустой репозиторий на GitHub и загрузите содержимое папки проекта.
2. Откройте **Settings → Pages → Source → GitHub Actions**.
3. Workflow `.github/workflows/pages.yml` опубликует статические файлы. Все пути относительные, поэтому project path поддерживается.
4. Если URL репозитория отличается, origin для CORS остаётся `https://ВАШ_ЛОГИН.github.io` (без project path).

## 7. Обновления

Frontend обновляется после push в `main`. Backend: создайте новую версию функции из актуального ZIP, проверьте `/health`, затем переключите трафик. Secret меняется новой версией Lockbox без изменения кода.
