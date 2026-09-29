# Подготовка к GitHub

В репозиторий входят исходный код, тесты, скрипты диагностики, документация, `.env.example` и `package-lock.json`. `package.json` помечает пакет как `private`, поэтому случайная публикация в npm через обычный `npm publish` заблокирована.

В Git **не входят** `.env` и другие локальные env-файлы, `data/` со снимками библиотеки, токенами, backup и журналами, `node_modules/`, `dist/`, локальные кэши, логи, файлы IDE и рабочий `HANDOFF.md`. Эти файлы остаются на компьютере; `.gitignore` не удаляет их. Никогда не используйте `git add -f` для этих путей.

Перед отправкой изменений:

```powershell
npm ci
npm test
npm run build
git status --short
git diff --cached --check
git ls-files
git check-ignore .env data/soundcloud-discovery.json dist/index.html node_modules/.package-lock.json HANDOFF.md
```

Проверьте список `git ls-files`: в нём не должно быть токенов, `.env`, `data/`, сборки или локальных отчётов. `git check-ignore` должен подтвердить, что приватные пути игнорируются. Если секрет когда-либо попал в коммит, одного добавления в `.gitignore` недостаточно: секрет надо сменить, а историю очистить до публикации.

Для первого push понадобится URL вашего **пустого** GitHub-репозитория. После его создания добавьте remote и отправьте текущую ветку:

```powershell
git remote add origin <URL_ВАШЕГО_РЕПОЗИТОРИЯ>
git push -u origin HEAD
```

Не переносите на GitHub каталог `data/` ради возобновления миграции: сохраните его локально или передайте отдельно безопасным способом.
