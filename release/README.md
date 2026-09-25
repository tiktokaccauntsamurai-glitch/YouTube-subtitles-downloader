# Выпуск Firefox-дополнения на addons.mozilla.org

## Сборка

```
node plugins/firefox/test/check.js        # юнит-тесты
python release/build.py                   # -> release/dist/subtitles-to-markdown-<версия>.zip
npx web-ext lint --source-dir plugins/firefox --ignore-files "test/**" "README.md"
```

Перед загрузкой проверьте сам архив: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → выберите `.zip`.
Скачайте одно видео, один плейлист и один канал (ссылку с `?si=`).

Для следующего релиза поднимите `version` в `plugins/firefox/manifest.json`. AMO не принимает одну и ту же версию дважды.

## Загрузка

1. https://addons.mozilla.org/developers/ → **Submit a New Add-on**.
2. **On this site** (листинг в каталоге).
3. Платформы: только **Firefox** (desktop). Android не тестировался.
4. Загрузите zip. Вопрос про исходники: **No**. Код не минифицирован и не собран бандлером, ревьюер читает его прямо из архива.
5. Заполните листинг текстами ниже.

## Тексты листинга (English — основная локаль)

**Name:** Subtitles to Markdown for YouTube

**Summary** (≤ 250 символов):

> Save the subtitles of a YouTube video, playlist or channel as clean Markdown files — readable paragraphs with optional timestamps. Uses your existing browser session; no accounts, no servers, no data collection.

**Description:**

> Turns YouTube subtitles into readable Markdown notes.
>
> Paste a link to a video, a playlist or a whole channel (or just open a video and click the toolbar button) and the subtitles are saved to your Downloads folder as a .md file: a header with the title, channel, date and duration, followed by the transcript grouped into paragraphs.
>
> **Features**
> • Videos, playlists and channels (a playlist or channel gets its own folder)
> • Picks the best track automatically: manual subtitles first, auto-generated as a fallback, in your language or the video's own
> • Force any language code (ja, de, es…)
> • Timestamps on or off
> • Limit for long playlists; a job keeps running when the popup is closed
>
> **Privacy**
> The add-on talks to youtube.com only, and only from a youtube.com tab, so your normal signed-in session is used — age-restricted videos work without exporting cookies. It never reads, stores or sends cookies, has no analytics and collects no data. The only thing it stores is your language/timestamp/limit settings, locally.
>
> Not affiliated with or endorsed by YouTube or Google.

**Categories:** Download Management; Photos, Music & Videos
**Tags:** youtube, subtitles, captions, transcript, markdown
**Privacy policy:** не нужна (данные не собираются, в манифесте `data_collection_permissions: none`)
**License:** на ваш выбор. В репозитории пока нет файла LICENSE; для открытого кода обычно берут MIT или MPL-2.0.
**Support site / email:** ссылка на GitHub-репозиторий (Issues)

## Русская локализация листинга (необязательно)

**Summary:**

> Сохраняет субтитры видео, плейлиста или канала YouTube в аккуратные Markdown-файлы — абзацы текста с таймкодами по желанию. Работает через вашу сессию в браузере: без аккаунтов, серверов и сбора данных.

**Description:**

> Превращает субтитры YouTube в читаемые заметки в Markdown.
>
> Вставьте ссылку на видео, плейлист или целый канал (или просто откройте видео и нажмите кнопку на панели) — субтитры сохранятся в «Загрузки» файлом .md: шапка с названием, каналом, датой и длительностью, дальше текст, разбитый на абзацы.
>
> **Возможности**
> • Видео, плейлисты и каналы (для плейлиста и канала — отдельная папка)
> • Сам выбирает лучшую дорожку: сначала ручные субтитры, иначе автоматические, на вашем языке или языке видео
> • Можно указать любой код языка (ja, de, es…)
> • Таймкоды можно выключить
> • Лимит для длинных плейлистов; работа продолжается, когда окно закрыто
>
> **Приватность**
> Дополнение обращается только к youtube.com и только из вкладки youtube.com, поэтому используется ваша обычная сессия — видео 18+ работают без экспорта cookies. Cookies не читаются, не хранятся и никуда не отправляются, аналитики нет, данные не собираются. Локально хранятся только настройки языка, таймкодов и лимита.
>
> Не связано с YouTube или Google и не одобрено ими.

## Notes to Reviewer (вставить в поле при загрузке)

> No build step, no minification, no remote code: the package is the source.
>
> How it works: the background script never makes network requests itself. It sends "fetch this URL" messages to content.js running on a www.youtube.com tab (a tab the user already has open, or a background tab it opens and closes after the job). Requests are therefore made in the page's own session; the add-on has no "cookies" permission and never touches cookies. All URLs are canonicalized to https://www.youtube.com (lib/youtube.js, canonicalUrl) before use; the only other URLs fetched are the caption-track baseUrls taken from YouTube's own player response, and the youtubei/v1/browse endpoint for playlist continuation pages.
>
> Results are written with downloads.download from a Blob URL. storage.local holds three UI settings. alarms keeps the event page alive during long playlist runs. scripting injects content.js into youtube.com tabs that were open before installation.
>
> To test: open the popup, paste https://www.youtube.com/watch?v=dQw4w9WgXcQ, click "Save subtitles" — a .md file appears in Downloads. Unit tests for lib/ are in the repository (node test/check.js).

## Что проверить перед загрузкой

- [ ] zip загружен как временное дополнение и работает (видео, плейлист, канал)
- [ ] `version` в манифесте новая
- [ ] ID `yt-subs-md@local` навсегда привязывается к листингу. Если хотите другой (например, `subtitles-md@<ваш-домен>`), поменяйте его **до** первой загрузки
- [ ] выбрана лицензия
