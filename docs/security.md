# Безопасность

- `PROXYAPI_KEY` существует только как Lockbox secret, доступный Service Account функции.
- `ALLOWED_ORIGINS` содержит точный production origin и, при необходимости, localhost.
- Функция ограничивает MIME, число файлов, 8 МБ на файл, 12 МБ multipart и 1 МБ analysis JSON.
- Логи не содержат body, Authorization, base64, текст объявления или отчёт.
- Таймаут AI по умолчанию 75 секунд; ошибки production не содержат stack trace.
- In-memory rate limit — базовая защита одного инстанса. Для строго общей квоты используйте API Gateway throttling.
- Не добавляйте ключ в GitHub Secrets для frontend workflow: он frontend не нужен.
