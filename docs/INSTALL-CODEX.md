# Установка в Codex

## 1. Установите системные программы

Нужны Node.js 20+, FFmpeg, FFprobe и официальный HeyGen CLI.

Проверьте Node.js и FFmpeg:

```bash
node --version
ffmpeg -version
ffprobe -version
```

Установите HeyGen CLI и войдите через браузер:

```bash
curl -fsSL https://static.heygen.ai/cli/install.sh | bash
heygen auth login
```

API-ключ создавать и добавлять не нужно.

## 2. Установите скилл

```bash
git clone https://github.com/mcdenil-skills/heygen-avatar-oauth.git
cd heygen-avatar-oauth
bash scripts/install.sh codex
```

Установщик копирует только `SKILL.md` и два клиента в
`~/.agents/skills/heygen-avatar-oauth`. Авторизация, настройки аккаунта и медиа
не копируются.

## 3. Проверьте подключение

```bash
node "$HOME/.agents/skills/heygen-avatar-oauth/scripts/heygen-client.mjs" doctor
```

Продолжайте только при `ok: true`, `credentialType: oauth` и
`billingType: subscription`.

## 4. Запустите Codex

Если Codex уже открыт и скилл не появился, перезапустите приложение или CLI.
Затем напишите:

> Используй heygen-avatar-oauth. Покажи мои личные аватары, ничего не создавай.

Это безопасная проверка: она читает каталог и не расходует кредиты.

После этого можно приложить голосовое и написать:

> Используй мою запись как точный звук. Выбери подходящий образ 9:16 и создай один ролик.

Последняя команда уже разрешает одну платную генерацию за кредиты подписки.

Для видео из текста дополнительно задайте локальные `ELEVENLABS_API` и
`ELEVENLABS_VOICE_ID`, затем напишите:

> Создай ролик по этому тексту моим голосом ElevenLabs. Сначала покажи личные аватары и согласуй со мной образ.

Значения переменных не добавляйте в репозиторий или сообщения агенту.

Официальная справка по каталогам скиллов Codex:
[Build skills](https://developers.openai.com/codex/skills/).
