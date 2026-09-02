# SPEC — Полевой анализатор недвижимости

## 1. Цель и сценарий

Приложение помогает агенту или покупателю за одну сессию сравнить целевой объект с 1–10 конкурентами по скриншотам объявлений. Оно не является CRM и не хранит историю. Основной вопрос отчёта: почему рациональный покупатель выберет цель между более дешёвой и более сильной альтернативой.

## 2. Полевой workflow

1. На чистом экране пользователь добавляет 1–2 PNG/JPEG/WebP целевого объекта.
2. Добавляет конкурентов, каждому 1–2 изображения и необязательный комментарий.
3. Нажимает «Запустить анализ».
4. Клиент уменьшает изображения, извлекает объекты с параллелизмом 2, освобождает Blob/Object URL сразу после extraction, считает арифметику локально и вызывает итоговый анализ без изображений.
5. Готовый минимальный JSON передаётся на `report.html` через `sessionStorage`.
6. Пользователь читает, печатает или скачивает Markdown/JSON и начинает новый анализ.

На телефоне используются крупные touch-targets, вертикальные карточки и sticky-кнопка. На desktop добавляется drag-and-drop и двухколоночная раскладка. Обязателен только файл; поля объявления вручную не вводятся.

## 3. Архитектура

- Frontend: статические HTML/CSS/JS, GitHub Pages, относительные URL, PWA app shell.
- Backend: одна stateless Yandex Cloud Function с маршрутами `GET /api/health`, `POST /api/extract-object`, `POST /api/analyze`.
- AI: adapter ProxyAPI/OpenRouter. `VISION_MODEL` и `ANALYSIS_MODEL` независимы. Backend использует OpenAI-compatible `/chat/completions`.
- Secret: только Yandex Lockbox; функция получает значение в `PROXYAPI_KEY` через секрет окружения. Никаких баз, Object Storage или серверной истории.

## 4. Жизненный цикл данных

Изображения существуют в File/Blob и Object URL только в памяти `index.html`. Они не записываются в localStorage, IndexedDB, Cache Storage или sessionStorage. После успешного extraction ссылки отзываются, массивы очищаются. При итоговом анализе сервер получает только JSON. `sessionStorage` содержит `rea:sessionId` и `rea:report`; новый обычный вход на `index.html` без `?session=` и кнопка «Новый анализ» очищают их. Service Worker кеширует только статический shell и всегда обходит API/POST.

## 5. API-контракты и схемы

`extract-object`: multipart form-data, `images` (1–2), `role`, `comment`, максимум 12 МБ запроса. Ответ `{ok:true,data:Extraction}`. Каждый объект — отдельный запрос. `analyze`: JSON `{target,competitors,calculations,unknowns}` до 1 МБ; ответ `{ok:true,data:Analysis}`. `health`: `{ok,providerConfigured}` без секретов. Ответ модели проходит JSON.parse → AJV schema → normalization; одна repair-попытка, затем безопасная ошибка.

Extraction и Analysis описаны в `schemas/*.schema.json`. Существенные выводы имеют статус `ФАКТ | ГИПОТЕЗА | НУЖНО ПРОВЕРИТЬ | ПРОТИВОРЕЧИЕ`.

## 6. Состояния и ошибки

Состояния UI: idle, preparing, extracting(target/competitor), calculating, analyzing, ready, partial-error, offline/error. Ошибка конкурента сохраняет успешные extraction; пользователь может повторить, удалить его или продолжить. Ошибка финального анализа допускает повтор без изображений, пока вкладка открыта. Обработаны offline, timeout, 401/403/429/5xx, MIME/размер, malformed JSON, refusal и provider unavailable.

## 7. Отчёт

Сверху: объект, итог за 30 секунд и триада дешевле → цель → дороже. Далее компактные секции: сравнение, плюсы/риски, защита цены, buyer value, аудитория, упаковка, конкуренты снизу/сверху, противоречия, звонок, осмотр, storytelling, позиционирование, главный вопрос к цене и итог. Экспорт создаётся локально.

## 8. Безопасность и развёртывание

CORS allowlist задаётся `ALLOWED_ORIGINS`; localhost допускается только явно. Проверяются origin, MIME и размер, выставляются timeout, rate-limit на best-effort уровне одного инстанса. Payload, Authorization и изображения не логируются. В логах только request id, endpoint, latency, status, размер и тип ошибки. Production stack traces не возвращаются.

Frontend разворачивает GitHub Actions. Backend — Yandex Cloud Function; Lockbox и Service Account настраиваются по `docs/deployment-yandex.md`. Backend URL задаётся в `assets/js/config.js`.

## 9. Acceptance и тест-план

- 1/2 изображения цели; 1 и 5+ конкурентов; add/replace/delete; drag/drop/mobile picker.
- Частичный extraction failure и повтор; финальный retry без повторной загрузки.
- Корректные deterministic calculations, lower/target/upper и отсутствующие значения.
- Отчёт, Markdown/JSON/print, reset и свежий запуск.
- Нет изображений в storage/cache; POST/API network-only; нет истории/аккаунта.
- Проверка schema validation, CORS, limits, таймаутов и безопасных ошибок.
- PWA manifest/scope/offline shell и GitHub project subpath.

## 10. Self-review SPEC

Противоречий с ephemeral-моделью нет: PWA кеширует код, не пользовательские данные; повтор финального анализа держит extracted JSON только в памяти текущей вкладки; переход к отчёту хранит только итоговый JSON текущей сессии. Rate limiting без общей БД является базовой защитой, не строгой глобальной квотой; для публичного URL рекомендуется API Gateway quota.
