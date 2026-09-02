# Чек-лист публикации

Этот файл нужен владельцу репозитория перед первым `git push` и перед каждым релизом.

## 1. Локальная проверка

```bash
npm ci
npm run verify
git status --short
git diff --cached
```

В публикуемых файлах не должно быть OAuth, email, реальных ID, абсолютных личных
путей, аудио, фотографий и видео.

Если установлен Gitleaks:

```bash
gitleaks git --no-banner
```

## 2. Создание репозитория

Создайте на GitHub пустой публичный репозиторий `heygen-avatar-oauth`, без автоматически
добавленных README и лицензии. Затем из этой папки выполните:

```bash
git add -A
git commit -m "feat: первая публичная версия"
git remote add origin https://github.com/Ntmib/heygen-avatar-oauth.git
git push -u origin main
```

Перед `git push` ещё раз просмотрите staged-изменения. Публикация необратимо разносит
историю по клонам, поэтому секрет нельзя считать удалённым простым следующим коммитом.

## 3. Настройки GitHub

- включите Private vulnerability reporting или Security Advisories;
- дождитесь зелёных проверок Node.js 20, Node.js 22 и Gitleaks;
- запретите слияние Pull Request при красном CI;
- включите Dependabot;
- добавьте краткое описание: «Русскоязычный HeyGen Avatar Skill для Codex и Claude Code через OAuth и кредиты подписки».

## 4. Релиз

После зелёного CI создайте тег `v1.0.0` и GitHub Release. В описание релиза перенесите
раздел `1.0.0` из `CHANGELOG.md` и укажите, что проект неофициальный.
