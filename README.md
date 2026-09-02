# Полевой анализатор недвижимости

Готовая mobile-first PWA: загружает скриншоты цели и конкурентов, извлекает факты отдельными AI-запросами, считает арифметику на устройстве и формирует сравнительный отчёт. История, аккаунты и долговременное хранение пользовательских данных отсутствуют.

## Что внутри

- `index.html` — загрузка и прогресс;
- `report.html` — отчёт и локальный экспорт;
- `backend/` — stateless Yandex Cloud Function;
- `schemas/` и `prompts/` — проверяемые контракты и компактная методология;
- `docs/deployment-yandex.md` — пошаговая настройка;
- `.github/workflows/pages.yml` — GitHub Pages.

## Перед первым запуском

1. Разверните backend по `docs/deployment-yandex.md`.
2. Впишите его публичный HTTPS URL в `assets/js/config.js`.
3. Укажите точный GitHub Pages origin в `ALLOWED_ORIGINS` функции.
4. Опубликуйте репозиторий через GitHub Pages.

## Модели

`VISION_MODEL` должна реально поддерживать OpenAI-compatible image input через ProxyAPI/OpenRouter; `ANALYSIS_MODEL` может быть отдельной текстовой reasoning-моделью. `deepseek/deepseek-chat` нельзя считать vision-моделью без проверки. Выполните реальный тест одного скриншота до production: `/health` подтверждает только наличие конфигурации, а не способность модели видеть изображения.

## Локальная проверка

Статические файлы нужно открывать через HTTP-сервер (не `file://`), иначе Service Worker не зарегистрируется. Backend-тесты: `cd backend && npm install && npm test`.
