# Установка в Claude Code

## 1. Установите системные программы

Нужны Node.js 20+, FFmpeg, FFprobe и официальный HeyGen CLI.

```bash
node --version
ffmpeg -version
ffprobe -version
curl -fsSL https://static.heygen.ai/cli/install.sh | bash
heygen auth login
```

Вход выполняется в браузере через OAuth. API-ключ не нужен.

## 2. Установите скилл

```bash
git clone https://github.com/Ntmib/heygen-avatar-oauth.git
cd heygen-avatar-oauth
bash scripts/install.sh claude
```

Установщик копирует только файлы скилла в
`~/.claude/skills/heygen-avatar-oauth`. Он не переносит OAuth, личные ID или медиа.

## 3. Проверьте подключение

```bash
node "$HOME/.claude/skills/heygen-avatar-oauth/scripts/heygen-client.mjs" doctor
```

Нормальный ответ содержит `ok: true`, `credentialType: oauth` и
`billingType: subscription`.

## 4. Запустите Claude Code

Claude Code обычно замечает изменения в каталоге скиллов автоматически. Если каталог
создан впервые и команда не появилась, перезапустите Claude Code.

Безопасная первая команда:

> Используй /heygen-avatar-oauth. Покажи мои личные аватары, ничего не создавай.

Для ролика из своего голоса приложите аудиофайл или голосовое и напишите:

> Используй мою запись без переозвучивания. Сделай один горизонтальный ролик с моим аватаром.

Создание начнётся только после явной команды и расходует кредиты подписки.

Официальная справка Claude Code:
[Extend Claude with skills](https://code.claude.com/docs/en/skills).
