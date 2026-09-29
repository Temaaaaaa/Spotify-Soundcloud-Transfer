# Справочные материалы по API

Проект использует официальные публичные API. Эти ссылки помогают сверять поведение интеграции при изменениях у провайдеров:

- [Spotify Web API — playlist items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items): чтение содержимого исходных плейлистов и ограничения доступа.
- [Spotify Web API — authorization code](https://developer.spotify.com/documentation/web-api/tutorials/code-flow): server-side OAuth с client secret и тем же redirect URI при authorize и token exchange.
- [SoundCloud API Guide](https://developers.soundcloud.com/docs/api/guide): OAuth, refresh tokens, Likes и пагинация.
- [SoundCloud API Explorer](https://developers.soundcloud.com/docs/api/explorer/): формы запросов к трекам и плейлистам.

Поведение реального аккаунта и доступность конкретных треков проверяются read-back в ходе переноса. Этот файл не содержит результатов или данных чьего-либо аккаунта.
