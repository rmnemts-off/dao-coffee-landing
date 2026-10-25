# Nginx и Node.js: шаблоны размещения

Это локально подготовленные файлы, а не выполненная настройка сервера. Общий порядок релизов, настройки окружения и отката — в [backend/deploy/README.md](../README.md). Секреты здесь не хранятся. Grafana и остальные компоненты мониторинга не публикуются через этот Nginx.

## Предпосылки

- Поддерживаемая Linux-система с systemd; точная ОС пока не подтверждена. Пути установки рассчитаны на пакетный Nginx Debian/Ubuntu и должны быть проверены на целевом сервере.
- Nginx не ниже 1.19.4 с HTTP SSL module и TLS 1.3: шаблон отклоняет неизвестный SNI через `ssl_reject_handshake`. Нужны обычные HTTP proxy, map и log modules.
- Последний исправленный Node.js 24 LTS по пути `/usr/bin/node`. Версию нужно проверить до установки unit; Node из интерактивного `nvm`-профиля не используется.
- Системные пользователь и группа `dao-coffee` уже созданы. Релиз доступен им на чтение в `/srv/dao-coffee/current`; менять релизы и системные конфиги этому пользователю нельзя. Пользователь Nginx имеет доступ на чтение только к публичным файлам `site/` и ACME challenge.
- Один подтверждённый канонический домен; `APP_ORIGIN=https://этот-домен`. Шаблоны не добавляют `www` и другие имена автоматически. Никакого CDN/внешнего proxy перед Nginx в этой схеме нет. Глобальные `real_ip_header`, `set_real_ip_from` и другие настройки изменения `$remote_addr` необходимо проверить: доверять произвольным клиентским заголовкам нельзя.
- Публичны TCP 80/443; административный SSH ограничен отдельно. API `127.0.0.1:4322`, Grafana, Prometheus и exporters остаются на loopback. IPv6 `listen` оставляют при доступном IPv6; запись AAAA публикуют только для работающего адреса.

## Назначение файлов

| Файл | Назначение и путь после установки |
| --- | --- |
| `00-dao-logging.conf` | Формат безопасного access-log; `/etc/nginx/conf.d/00-dao-logging.conf`, ровно один include внутри `http {}` до server-файлов |
| `dao-server-defaults.conf` | Ограничения запросов и журналирование; `/etc/nginx/snippets/dao-server-defaults.conf` |
| `dao-acme.conf` | Только публичные HTTP-01 challenge; `/etc/nginx/snippets/dao-acme.conf` |
| `dao-private-locations.conf` | Закрывает health, monitoring и dotfiles; `/etc/nginx/snippets/dao-private-locations.conf` |
| `dao-site.conf` | Статика и точный маршрут API; `/etc/nginx/snippets/dao-site.conf` |
| `dao-http-bootstrap.conf.template` | Начальный HTTP vhost до выпуска сертификата |
| `dao-https.conf.template` | Рабочие HTTP redirect и HTTPS vhost после выпуска сертификата |
| `certbot-deploy-hook.sh` | Проверка Nginx и reload после успешного обновления сертификата |
| `../systemd/dao-coffee-api.service` | Единственный Node-процесс; `/etc/systemd/system/dao-coffee-api.service` |

Оба шаблона содержат `__DAO_DOMAIN__`: заменить на проверенное DNS-имя во всех вхождениях, включая путь сертификата. Включается **только один** из двух server-файлов под именем `/etc/nginx/sites-available/dao-coffee.conf`. Ссылка из `sites-enabled` указывает на него. Сначала проверить существующие vhosts: второй `default_server` на том же адресе/порту конфликтует с этим шаблоном. Не удалять чужую конфигурацию вслепую.

`dao-*.conf` — snippets, а не самостоятельные файлы для `/etc/nginx/conf.d/`: этот каталог обычно включается внутри `http {}`, где `location` недопустим. Для конфигурации без `sites-enabled` нужно включить подготовленный server-файл внутри `http {}` после `00-dao-logging.conf`.

## HTTP bootstrap и Certbot

1. Установить snippets и формат логов, подготовить bootstrap с подтверждённым доменом. Создать root-owned каталог `/var/lib/letsencrypt/.well-known/acme-challenge`, доступный Nginx на чтение. Проверить include-порядок, доступность TCP 80 и правильность A/AAAA.
2. Проверить конфигурацию через `nginx -t`, затем запустить Nginx или выполнить reload существующего сервиса. Bootstrap отдаёт только challenge-файлы, прочие запросы получают `503`. Формы и API по открытому HTTP не работают. Health/monitoring-пути получают `404`; запросы с чужим Host отклоняются.
3. Выпустить сертификат с **webroot authenticator**, сохраняя конфиги под контролем проекта. Пример ниже — схема команды, не команда с реальными параметрами:

   ```sh
   certbot certonly --webroot --webroot-path /var/lib/letsencrypt \
     --cert-name CONFIRMED_DOMAIN -d CONFIRMED_DOMAIN \
     --email CONFIRMED_ADMIN_EMAIL --agree-tos
   ```

   `CONFIRMED_DOMAIN` и email заменить до запуска. Использование `--cert-name` связывает имя каталога `/etc/letsencrypt/live/` с именем в шаблоне. Если сертификат уже существует, сначала проверить его фактическое имя, а не предполагать отсутствие суффикса `-0001`. Самоподписанные сертификаты не подставлять в production.
4. Подготовить HTTPS-шаблон, проверить существование `fullchain.pem` и `privkey.pem`. Заменить активный bootstrap-файл, выполнить `nginx -t` и только при успехе reload. Если проверка не прошла, вернуть прежний файл; работающий процесс не останавливать. HTTPS отдаёт только `/srv/dao-coffee/current/site`, а HTTP сохраняет challenge и перенаправляет остальные публичные пути на фиксированный канонический домен.
5. Установить `certbot-deploy-hook.sh` как root-owned исполняемый файл `/etc/letsencrypt/renewal-hooks/deploy/dao-nginx-reload`, права `0755`. Проверить абсолютные пути `/usr/sbin/nginx` и `/usr/bin/systemctl`. Hook сначала проверяет конфигурацию, затем выполняет reload; приватный ключ не копируется в репозиторий или релиз.
6. Проверить установленный механизм автоматического renewal: он зависит от способа установки Certbot (пакет/timer/snap). Выполнить `certbot renew --dry-run`, а hook проверить отдельно. Обычный `--dry-run` не запускает deploy hooks; при необходимости использовать поддерживаемый установленной версией `--run-deploy-hooks`. Не создавать второй timer поверх уже действующего.

Описанный Certbot запускается только после подтверждения DNS и доступа к серверу. HTTPS-шаблон нельзя включить до появления сертификата: `nginx -t` закономерно завершится ошибкой чтения PEM-файлов.

## API, ограничения и журналы

Только точный путь `/api/leads` проксируется на `127.0.0.1:4322`. Остальные `/api` и `/api/…` возвращают `404`; `/healthz`, `/metrics`, служебные health-пути и пути мониторинга наружу не проксируются. Проверка процесса выполняется напрямую: `http://127.0.0.1:4322/healthz`. Она не подтверждает связь с Bitrix24. Разрешённые методы и Origin валидирует сам API, поэтому его ответы `405/403` сохраняются.

Nginx перезаписывает `X-Real-IP` значением `$remote_addr`, удаляет переданные клиентом `Forwarded` и `X-Forwarded-For`. API запускается с `TRUST_LOOPBACK_PROXY=1` и принимает этот адрес только от loopback peer. Не изменять listener API на `0.0.0.0`, не проксировать из Docker bridge без пересмотра этой модели.

Размер тела ограничен **8192 байтами** в Nginx и повторно в Node. Ответ Nginx `413` для API оформлен в JSON. Request buffering отключён, поэтому Node применяет собственное полное время чтения тела; маленькие JSON-заявки не должны попадать в proxy temp files. Nginx ограничивает ожидание заголовков/тела по 20 секунд, запись клиенту и чтение/запись upstream — по 30 секунд; локальное соединение с API устанавливается не дольше 3 секунд. Эти интервалы Nginx обычно измеряются между операциями чтения/записи, а не как общий deadline запроса. Bitrix24 имеет собственный deadline; timeout браузера — 20 секунд.

`proxy_next_upstream off` отключает повторную отправку Nginx. Успешный ответ API возвращается только после Bitrix24; неизвестный результат не маскируется. Нельзя добавлять несколько API workers/replicas: защита от дублей и лимиты остаются в памяти одного процесса. Перезапуск очищает эту память.

Access-log `/var/log/nginx/dao-access.log` содержит только время, фиксированную метку маршрута, HTTP-status, размер и длительность. В нём **нет** IP, URI/пути, query string, request body, произвольных заголовков, Referer или User-Agent. Обычный error-log Nginx способен включать адрес клиента и полный URI, поэтому для этих vhosts он направлен в `/dev/null`; подробная диагностика ошибок запросов сознательно заменена безопасными статусами и метриками. Не включать debug/combined logging для production-заявок. Проверить, что другие глобальные конфиги не добавляют дополнительные журналы, real-IP trust или request-mirroring.

На сервере проверить, что штатный logrotate действительно охватывает `/var/log/nginx/dao-access.log`, и задать ограниченное хранение. Никакого хранения заявок Nginx не добавляет. Доступ Nginx к ACME-каталогу — единственное исключение из публичного корня `site/`; там допустимы только challenge-файлы.

## systemd

Unit использует `/usr/bin/node backend/server.mjs` напрямую: `npm`, dev dependencies и preview-сервер в production не запускаются. `/etc/dao-coffee/api.env` хранится вне релизов, принадлежит root с правами `0600` в закрытом каталоге. systemd читает его перед сменой пользователя; процесс получает значения через окружение. Не вставлять реальные значения в unit, команды, журнал или `systemctl show … -p Environment`.

Нужны `APP_ORIGIN`, `BITRIX_WEBHOOK_URL` и согласованные `BITRIX_ENTITY_TYPE_ID`, `BITRIX_ASSIGNED_BY_ID`, `BITRIX_STAGE_ID`; для сделок также `BITRIX_CATEGORY_ID`. Необязательный `BITRIX_SOURCE_ID` задаётся после проверки справочника CRM. Значения `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=4322`, `TRUST_LOOPBACK_PROXY=1` заданы в unit. `EnvironmentFile` может их переопределить; `ExecStartPre` проверяет Node major 24 и все четыре значения, прекращая запуск при небезопасном переопределении без вывода окружения.

Процесс работает без привилегий и capabilities, с read-only системными каталогами, закрытыми home, отдельным tmp и запретом core dumps. Исходящие HTTPS/DNS и loopback сохраняются. Лимит памяти API — 512 МиБ: это защитная настройка, не измеренное потребление. Не добавлять `PrivateNetwork=yes` или `MemoryDenyWriteExecute=yes`: первое разрывает сеть, второе конфликтует с JIT V8. На целевой ОС проверить поддержку директив.

При остановке Node прекращает принимать новые заявки и ждёт активные отправки с собственным пределом 20 секунд; systemd даёт 30 секунд до принудительного завершения. Перезапуск не гарантирует сохранение незавершённых ответов и дедупликации. Автоматическое восстановление после аварии ограничено пятью стартами за минуту; ошибку конфигурации нужно исправить, а не создавать бесконечный restart loop.

## Проверка на целевом Linux

До запуска: `nginx -t`, `systemd-analyze verify /etc/systemd/system/dao-coffee-api.service`, проверка версии `/usr/bin/node`, прав на пути и сертификаты. Не использовать публичный `nginx -T`: чужая конфигурация может содержать чувствительные значения.

После запуска проверить:

- HTTP challenge доступен, неизвестный Host не обслуживает сайт, HTTP переводит на канонический HTTPS после завершения bootstrap.
- По HTTPS доступны HTML, CSS, JS, шрифты и изображения; `.env`, `/backend/`, `/healthz`, `/metrics`, `/grafana/` недоступны. В корне нет содержимого репозитория вне `site/`.
- `GET /api/leads` даёт `405`, несуществующие API-пути — `404`, тело больше 8192 байт — JSON `413`. Такие проверки не создают реальные заявки.
- С mock-адаптером в изолированной проверке: поддельный `X-Real-IP` перезаписывается, ошибки/timeout не вызывают повторные upstream-запросы, shutdown ждёт уже начатую отправку. Не заменять production upstream mock-процессом для этих тестов.
- Локальный `/healthz` работает; внешнее соединение с портом 4322 запрещено, как и с портами мониторинга.
- Синтетическая реальная заявка из формы доставляется только в разрешённый тестовый чат. Не отправлять тестовые сообщения нев согласованное место CRM.
- Access-log после синтетических запросов с query и заголовками не содержит этих значений; у systemd после reboot запущен ровно один API-процесс.

Локальная macOS без Nginx/systemd позволяет проверить shell-синтаксис hook и исходные файлы, но не заменяет `nginx -t`, проверку systemd и приёмку на целевом Linux.

Официальные справочники: [Nginx proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [HTTP core и timeouts](https://nginx.org/en/docs/http/ngx_http_core_module.html), [форматы журналов](https://nginx.org/en/docs/http/ngx_http_log_module.html), [TLS](https://nginx.org/en/docs/http/ngx_http_ssl_module.html), [Certbot webroot и renewal](https://eff-certbot.readthedocs.io/en/stable/using.html), [systemd execution environment](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
