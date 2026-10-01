# Saved reels — setup

Nothing is stored locally. The harvest runs here (a Worker cannot drive a
browser, and reading a saved collection needs a logged-in Instagram session)
and POSTs straight to Veda's Cloudflare account; every device then reads the
cloud.

```
  driver.py reels  ──►  studyos-api.vedapatel05.workers.dev/reels
                              │  (service account)
                        dashboards/veda_reels
                              │  onSnapshot
                        TaskHub widget (any device)
```

## One-time

```powershell
# 1. Sign in to Instagram once (a real window opens; no automation)
python driver.py login --site instagram

# 2. The shared key for the Worker route. Use the SAME value in both places.
cd ..\..\workers\studyos-api
npx wrangler secret put REELS_KEY
cd ..\..\tools\sos-browser
setx REELS_KEY "<that same value>"     # then reopen the terminal
```

## Everyday

```powershell
# List your IG collections and publish them as the widget's picker (no scraping)
python driver.py reels --collections

# Harvest one collection and publish it
python driver.py reels --collection carsz

# Cheap checks
python driver.py reels --dry-run                 # are the selectors still right?
python driver.py reels --probe                   # has the collection changed?
```

Pick a collection in the widget's panel to set which one the *next* harvest
publishes; the page cannot fetch it itself.

## When it breaks

`--dry-run` first, always. It stops before the scroll loop, so repairing a
selector costs one page load instead of a full scrape. Selectors live in
`selectors.yaml` under `reels.instagram`, newest at the top.

A collection's real URL is `/saved/<slug>/<numeric-id>/`. The slug alone
redirects to the saved index, which has no reels on it — so if a harvest reports
`ig_collection_redirect`, re-run `--collections` to refresh the ids.
