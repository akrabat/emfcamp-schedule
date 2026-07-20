# EMF 2026 Schedule

An unofficial, filterable schedule viewer for [Electromagnetic Field 2026](https://www.emfcamp.org/schedule/2026),
built on the public [EMF Schedule API](https://developer.emfcamp.org/schedule/).

Every filter is stored in the URL query string, so any view you build can be
bookmarked or shared as a link. Open a shared link and it restores exactly the
same filters.

## Features

- Live data from `https://www.emfcamp.org/schedule/2026.json`, cached in the
  browser so it still works offline and loads instantly on repeat visits.
- Filter by search text, day, type, venue, family friendly, and favourites, all
  reflected in the URL.
- Schedule grouped by day and sorted by start time, with type badges, speaker,
  venue (linking to the EMF map), duration, and lottery / cost / age tags.
- Favourites saved locally (per browser), with a favourites-only filter,
  and *optional one-click sync* from your EMF account (see below).
- Light / dark / auto theme, responsive layout with a mobile filter drawer.
- No build step and no dependencies: three static files.

## Syncing favourites from your EMF account

Favourites are normally stored per-browser. You can also pull the favourites
from your EMF account into the current browser, under the **Sync favourites**
panel in the filters:

1. Log in at [emfcamp.org](https://www.emfcamp.org) and open
   [emfcamp.org/favourites](https://www.emfcamp.org/favourites).
2. Copy the whole JSON or webcal feed link and paste it into the box (the token
   is extracted from it; a bare `token=…` value works too).
3. Press *Sync now*. This replaces the favourites saved in this browser
   with those from your account, so it stays an exact mirror (unfavourite
   something on EMF and it disappears here on the next sync; a one-click
   Undo is offered if any were removed). The token is remembered in this
   browser for next time; *Forget token* clears it. A ✓ Synced …*
   indicator shows how long ago the last sync ran.

   While a token is stored the in-app *stars are read-only as favourites are
   managed on your EMF account, not here. To change one, favourite it on
   emfcamp.org and sync again.

Alternatively, a *paste the JSON* import is provided: while logged in, open
your `favourites.json`, copy all, and paste it.

### How the sync works (and why the relay exists)

EMF's favourites feed (`https://www.emfcamp.org/favourites.json?token=…`) is
authenticated by a **persistent per-user token** but sends **no CORS headers**,
so the browser cannot fetch it cross-origin. The site therefore proxies it
server-side: nginx exposes a same-origin `/api/favourites.json` that forwards
the request (token and all) to emfcamp.org and returns the JSON. See
`nginx.conf`.

The relay is a **stateless pass-through**: the token travels from the browser on
each request and is **never stored, logged, or configured on the server**, so
the app stays multi-user, every browser carries its own token. The token is
kept only in the pasting browser's `localStorage`.

> **Treat the token like a password.** It does not expire and cannot be revoked
> individually, so anyone with it can read your favourites. It is only ever held
> in your own browser and passed through the relay; it is never in the page
> source or committed anywhere.

The sync relay needs the nginx setup, so it runs on the deployed site and under
`make up`, which brings up the Docker stack locally. On a plain static host
(for example `python3 -m http.server`) there is no relay, so use the paste
fallback there.

## Query parameters

All filters live in the query string. Combine any of them:

| Parameter | Example | Meaning |
|-----------|---------|---------|
| `q`       | `q=lockpicking` | Free-text search (title, speaker, description, venue). Multiple words all match. |
| `day`     | `day=sat,sun`   | Weekday codes: `thu`, `fri`, `sat`, `sun`. |
| `type`    | `type=talk,workshop` | One or more of: `talk`, `workshop`, `familyworkshop`, `performance`, `music`, `djset`, `meetup`, `film`. |
| `venue`   | `venue=Stage%20A,Stage%20B` | One or more venue names. |
| `family`  | `family=1`      | Only family-friendly events. |
| `fav`     | `fav=1`         | Only your saved favourites (stored in this browser). |

Multiple values are comma-separated. Example:

```
?q=radio&day=sat&type=talk,workshop&venue=Stage%20A
```

## Running it

It is a static site, so serve the folder with any web server. It must be served
over `http(s)` (not opened as a `file://` URL) so the browser can fetch the API.

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Deploy by copying `index.html`, `styles.css`, `app.js`, and the `icons/`
directory to any static host (GitHub Pages, Netlify, an S3 bucket, etc.). Everything works on a plain static
host except the favourites **sync**, which needs the `/api/favourites.json`
relay; use the Docker setup below (or any reverse proxy providing that path) if
you want sync. The paste fallback works anywhere.

### Docker

A `compose.yaml` is included that serves the site with nginx and restarts
automatically:

```sh
docker compose up -d
```

It binds `127.0.0.1:8090` so it is reachable only through a reverse proxy that
handles TLS. Only the required files, along with `nginx.conf` are mounted,
read-only. Our nginx config simply serves the static files and adds the
`/api/favourites.json` relay.

For local development, `make up` runs this same stack in the foreground (Ctrl-C
to stop) at `http://127.0.0.1:8090`, so the favourites relay and sync work
locally just as they do in production; `make down` stops and removes it.

## Files

- `index.html`: markup and layout
- `styles.css`: styling and theming
- `app.js`: data fetch, filtering, URL sync, and rendering
- `icons/`: favicon, home-screen icons, and web manifest (lightning bolt)
- `nginx.conf`: static serving plus the server-side favourites relay

## Notes

- When changing the app shell, bump `VERSION` in `serviceworker.js` so the
  service worker refreshes its offline cache.
- To target a different year, change `YEAR` at the top of `app.js`.
- Times are shown exactly as provided by the API (UK local time).
- Not affiliated with or endorsed by Electromagnetic Field.


## AI usage

This project was developed with the help of an LLM.
