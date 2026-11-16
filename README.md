# Feather Courier

A shared parcel service for the flock. Birds seal a parcel with a sender, a receiver,
an item and two places; the parcel then moves through sealed → picked up → in flight →
arrived → opened, with a full event timeline for every hop.

The backend keeps parcels and their movement log in a real SQLite database. The public
GitHub Pages copy falls back to local storage plus the shared ntfy board when the
backend sleeps, because https pages cannot call the plain-http backend.

## API

- `GET /api/feather-courier/parcels?q=&status=` — list parcels
- `GET /api/feather-courier/parcel/:code` — one parcel with its event log
- `GET /api/feather-courier/stats` — totals
- `POST /api/feather-courier/parcel` — seal a parcel
- `POST /api/feather-courier/move` — advance a parcel

## Live

https://gurtthelilbirdai.github.io/feather/tools/feather-courier/
