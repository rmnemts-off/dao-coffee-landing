# Nginx и Node.js: шаблоны размещения

Шаблон HTTPS по IP установлен и проверен на VPS; доменный вариант предназначен для последующего переноса DNS. Фактический статус — в [STATUS.md](../STATUS.md), общий порядок релизов, окружения и отката — в [backend/deploy/README.md](../README.md). Секреты здесь не хранятся. Grafana и остальные компоненты мониторинга не публикуются через этот Nginx.

## Предпосылки

- Поддерживаемая Linux-система с systemd. На VPS подтверждена Ubuntu 24.04.5 amd64; пути установки рассчитаны на пакетный Nginx Debian/Ubuntu и проверяются на целевом сервере.
- Nginx не ниже 1.19.4 с HTTP SSL module и TLS 1.3: доменный шаблон отклоняет неизвестный SNI через `ssl_reject_handshake`. IP-шаблон использует сертификат в default TLS vhost, поскольку при обращении по IP SNI обычно отсутствует. Нужны обычные HTTP proxy, map и log modules.
- Для API нужен последний исправленный Node.js 24 LTS по пути `/usr/bin/node`. Версию нужно проверить до установки unit; Node из интерактивного `nvm`-профиля не используется.
- Для API создаются системные пользователь и группа `dao-coffee`. Релиз доступен им на чтение в `/srv/dao-coffee/current`; менять релизы и системные конфиги этому пользователю нельзя. Для опубликованного сайта пользователь Nginx имеет доступ на чтение только к публичным файлам `site/` и ACME challenge. Начальный holding-конфиг не требует релиза или запущенного API.
- Для публикации нужен один согласованный HTTPS-origin: канонический домен либо IP с доверенным сертификатом для проверки до DNS. `APP_ORIGIN` точно соответствует этому адресу. До разрешения публикации использовать holding-конфиг ниже. Шаблоны не добавляют `www` и другие имена автоматически. Никакого CDN/внешнего proxy перед Nginx в этой схеме нет. Глобальные `real_ip_header`, `set_real_ip_from` и другие настройки изменения `$remote_addr` необходимо проверить: доверять произвольным клиентским заголовкам нельзя.
- Публичны TCP 80/443; административный SSH ограничен отдельно. API `127.0.0.1:4322`, Grafana, Prometheus и exporters остаются на loopback. IPv6 `listen` оставляют при доступном IPv6; запись AAAA публикуют только для работающего адреса.

## Назначение файлов

| Файл | Назначение и путь после установки |
| --- | --- |
| `00-dao-logging.conf` | Формат безопасного access-log; `/etc/nginx/conf.d/00-dao-logging.conf`, ровно один include внутри `http {}` до server-файлов |
| `dao-server-defaults.conf` | Ограничения запросов и журналирование; `/etc/nginx/snippets/dao-server-defaults.conf` |
| `dao-acme.conf` | Только публичные HTTP-01 challenge; `/etc/nginx/snippets/dao-acme.conf` |
| `dao-private-locations.conf` | Закрывает health, monitoring и dotfiles; `/etc/nginx/snippets/dao-private-locations.conf` |
| `dao-site.conf` | Статика и точный маршрут API; `/etc/nginx/snippets/dao-site.conf` |
| `dao-holding.conf` | HTTP-ответ `503` без домена, статики и API до согласования публикации |
| `dao-http-preview.conf` | Временный просмотр статики по HTTP; API отвечает `503`, реальные формы не подключены |
| `dao-http-bootstrap.conf.template` | Начальный HTTP vhost до выпуска сертификата |
| `dao-https.conf.template` | Рабочие HTTP redirect и HTTPS vhost после выпуска сертификата |
| `dao-ip-https.conf.template` | HTTPS по IPv4 до переноса DNS, рабочий API и HTTP-01 webroot |
| `certbot-deploy-hook.sh` | Проверка Nginx и reload после успешного обновления сертификата |
| `../systemd/dao-coffee-api.service` | Единственный Node-процесс; `/etc/systemd/system/dao-coffee-api.service` |
| `../systemd/dao-certbot-renew.{service,timer}` | Продление через `/opt/dao-certbot`, дважды в день |

`dao-holding.conf` и `dao-http-preview.conf` не требуют подстановки домена. Доменным шаблонам нужен `__DAO_DOMAIN__`: заменить на проверенное DNS-имя во всех вхождениях, включая путь сертификата. IP-шаблону нужен `__DAO_IPV4__`. Включается **только один** server-файл под именем `/etc/nginx/sites-available/dao-coffee.conf`. Ссылка из `sites-enabled` указывает на него. Сначала проверить существующие vhosts: второй `default_server` на том же адресе/порту конфликтует с конфигурацией DAO. Не удалять чужую конфигурацию вслепую.

`dao-server-defaults.conf`, `dao-acme.conf`, `dao-private-locations.conf` и `dao-site.conf` — snippets, а не самостоятельные файлы для `/etc/nginx/conf.d/`: этот каталог обычно включается внутри `http {}`, где `location` недопустим. Для конфигурации без `sites-enabled` нужно включить подготовленный server-файл внутри `http {}` после `00-dao-logging.conf`.

## HTTPS по IP до переноса домена

Этот вариант разрешён владельцем для удалённой проверки сайта и рабочих форм до смены DNS. Используется `dao-ip-https.conf.template`; HTTP перенаправляет на фиксированный HTTPS IP, служебные маршруты и `/design-system/` закрыты, `robots.txt` запрещает индексацию. Origin приложения — тот же HTTPS IP. Для другого IP сертификат нужно выпускать заново; доменный сертификат IP не покрывает.

Согласно [инструкции Let's Encrypt](https://letsencrypt.org/2026/03/11/shorter-certs-certbot), для IP через webroot нужен Certbot не ниже 5.4 и профиль `shortlived`. На VPS установлен Certbot 5.8.0 из официального PyPI в root-owned venv `/opt/dao-certbot`; пакетный Certbot 2.9 остаётся установленным, но его timer отключён. Короткий срок IP-сертификата требует автоматического продления.

Перед первым выпуском открыть HTTP-01 webroot `/var/lib/letsencrypt` через `dao-acme.conf` на порту 80. Не включать TLS-конфигурацию с ещё не существующими файлами сертификата. Выпустить сертификат через `/opt/dao-certbot/bin/certbot certonly --webroot --webroot-path /var/lib/letsencrypt --preferred-profile shortlived --ip-address <APPROVED_IPV4> --cert-name dao-ip`. Параметры регистрации ACME задаются оператором отдельно. Затем установить IP-шаблон, проверить `nginx -t` и включить HTTPS. Ключ находится только в `/etc/letsencrypt`.

Установить root-owned `certbot-deploy-hook.sh` с режимом `0755` в `/etc/letsencrypt/renewal-hooks/deploy/dao-nginx-reload`. Установить `dao-certbot-renew.service` и `.timer`, выполнить `systemctl daemon-reload`, включить новый timer и отключить старый `certbot.timer`. Новый timer запускается дважды в день с задержкой до часа; это проверка срока, а не принудительный выпуск каждый раз. Ограничения service разрешают запись в каталоги Certbot, журналы Nginx и существующий `/run/nginx.pid`: эти пути нужны проверке `nginx -t` внутри deploy hook.

В service отключена внутренняя случайная пауза Certbot через `--no-random-sleep-on-renew`: распределение запусков уже обеспечивает `RandomizedDelaySec=1h` в timer. Иначе дополнительная пауза может превысить `TimeoutStartSec=180s` ещё до обращения к ACME.

Проверить `/opt/dao-certbot/bin/certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew`, выполнение hook с теми же systemd-ограничениями и запуск нового service. Одна успешная проверка HTTPS не подтверждает будущую работу продления. Для перехода с уже работающего IP на домен использовать [составной bundle и процедуру миграции](../DOMAIN.md): они сохраняют IP TLS и HTTP-01. `APP_ORIGIN` и vhost переключаются согласованно; настройки CRM не меняются.

## До разрешения публикации

На новом сервере можно запустить `dao-holding.conf` без DNS, сертификата, фронтенда и доступа к Bitrix24. Он принимает запросы с любым Host на порту 80: обычные пути, включая `/api/leads`, получают `503` и `Cache-Control: no-store`; dotfiles и служебные пути получают `404`. В нём нет `root`, `proxy_pass` и ACME location, поэтому сайт, заявки и файлы challenge не обслуживаются. Grafana остаётся доступной только через SSH-туннель.

1. Проверить действующие vhosts. На подтверждённо новом сервере отключить штатную ссылку `sites-enabled/default`, сохранив исходный конфиг; не включать два `default_server`. При установке пакета предотвратить автоматический старт штатного сайта до записи holding-конфига.
2. Установить `00-dao-logging.conf` и два нужных snippet: `dao-server-defaults.conf`, `dao-private-locations.conf`. Скопировать `dao-holding.conf` в `/etc/nginx/sites-available/dao-coffee.conf` и включить его единственной соответствующей ссылкой в `sites-enabled`. Проверить поддержку IPv6 перед сохранением `listen [::]:80`.
3. Выполнить `nginx -t`, затем запустить Nginx либо reload уже работающего сервиса. Проверить ответы без отправки заявок:

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1/
   curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/leads
   curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1/.env
   curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1/grafana/
   ```

   Ожидаются `503`, `503`, `404`, `404`. Повторить GET `/` с произвольным заголовком Host: ответ также `503`. Проверить `ss -lntp`: holding-конфиг не добавляет listener на 443 или 4322. API unit остаётся выключенным до согласования origin и настроек Bitrix24.
4. После подтверждения домена заменить holding-конфиг на HTTP bootstrap, проверить `nginx -t` и выполнить reload. Далее следовать процедуре Certbot. Holding и bootstrap одновременно не включать; сама установка holding-конфига не меняет DNS и не публикует лендинг.

## HTTP bootstrap и Certbot

1. Установить snippets и формат логов, подготовить bootstrap с подтверждённым доменом. Создать root-owned каталог `/var/lib/letsencrypt/.well-known/acme-challenge`, доступный Nginx на чтение. Проверить include-порядок, доступность TCP 80 и правильность A/AAAA.
2. Проверить конфигурацию через `nginx -t`, затем запустить Nginx или выполнить reload существующего сервиса. Bootstrap отдаёт только challenge-файлы, прочие запросы получают `503`. Формы и API по открытому HTTP не работают. Health/monitoring-пути получают `404`; запросы с чужим Host отклоняются.
3. Выпустить сертификат с **webroot authenticator**, сохраняя конфиги под контролем проекта. Пример ниже — схема команды, не команда с реальными параметрами:

   ```sh
   /opt/dao-certbot/bin/certbot certonly --webroot --webroot-path /var/lib/letsencrypt \
     --cert-name CONFIRMED_DOMAIN -d CONFIRMED_DOMAIN \
     --email CONFIRMED_ADMIN_EMAIL --agree-tos
   ```

   `CONFIRMED_DOMAIN` и email заменить до запуска. Использование `--cert-name` связывает имя каталога `/etc/letsencrypt/live/` с именем в шаблоне. Если сертификат уже существует, сначала проверить его фактическое имя, а не предполагать отсутствие суффикса `-0001`. Самоподписанные сертификаты не подставлять в production.
4. Подготовить HTTPS-шаблон, проверить существование `fullchain.pem` и `privkey.pem`. Заменить активный bootstrap-файл, выполнить `nginx -t` и только при успехе reload. Если проверка не прошла, вернуть прежний файл; работающий процесс не останавливать. HTTPS отдаёт только `/srv/dao-coffee/current/site`, а HTTP сохраняет challenge и перенаправляет остальные публичные пути на фиксированный канонический домен.
5. Установить `certbot-deploy-hook.sh` как root-owned исполняемый файл `/etc/letsencrypt/renewal-hooks/deploy/dao-nginx-reload`, права `0755`. Проверить абсолютные пути `/usr/sbin/nginx` и `/usr/bin/systemctl`. Hook сначала проверяет конфигурацию, затем выполняет reload; приватный ключ не копируется в репозиторий или релиз.
6. Проверить установленный механизм автоматического renewal: он зависит от способа установки Certbot (пакет/timer/snap). Выполнить `/opt/dao-certbot/bin/certbot renew --dry-run --run-deploy-hooks`, а hook проверить отдельно. Обычный `--dry-run` не запускает deploy hooks; при необходимости использовать поддерживаемый установленной версией `--run-deploy-hooks`. Не создавать второй timer поверх уже действующего.

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

После публикации HTTPS-сайта и включения API проверить:

- HTTP challenge доступен, неизвестный Host не обслуживает сайт, HTTP переводит на канонический HTTPS после завершения bootstrap.
- По HTTPS доступны HTML, CSS, JS, шрифты и изображения; `.env`, `/backend/`, `/healthz`, `/metrics`, `/grafana/` недоступны. В корне нет содержимого репозитория вне `site/`.
- `GET /api/leads` даёт `405`, несуществующие API-пути — `404`, тело больше 8192 байт — JSON `413`. Такие проверки не создают реальные заявки.
- С mock-адаптером в изолированной проверке: поддельный `X-Real-IP` перезаписывается, ошибки/timeout не вызывают повторные upstream-запросы, shutdown ждёт уже начатую отправку. Не заменять production upstream mock-процессом для этих тестов.
- Локальный `/healthz` работает; внешнее соединение с портом 4322 запрещено, как и с портами мониторинга.
- Синтетическая реальная заявка из формы создаёт карточку только в согласованном тестовом месте Bitrix24 после проверки роботов CRM. До этого выполнять проверки с mock и запросы без создания карточек.
- Access-log после синтетических запросов с query и заголовками не содержит этих значений; у systemd после reboot запущен ровно один API-процесс.

Локальная macOS без Nginx/systemd позволяет проверить shell-синтаксис hook и исходные файлы, но не заменяет `nginx -t`, проверку systemd и приёмку на целевом Linux.

Официальные справочники: [Nginx proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [HTTP core и timeouts](https://nginx.org/en/docs/http/ngx_http_core_module.html), [форматы журналов](https://nginx.org/en/docs/http/ngx_http_log_module.html), [TLS](https://nginx.org/en/docs/http/ngx_http_ssl_module.html), [Certbot webroot и renewal](https://eff-certbot.readthedocs.io/en/stable/using.html), [systemd execution environment](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
