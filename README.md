# Curi

A full-screen feed of art, text, film and audio from open collections, one card at a time. Ranking runs on the device. Every card shows where it comes from and under which licence.

Live: https://user863.github.io/curi/

## Data collected

Sharing usage data is optional and off until you opt in through a form in the app. Planned, not live yet: nothing is sent from the app today. If you opt in, Curi collects usage data to improve the ranking:

- Time spent on each card (seconds) and how many cards were viewed per session.
- Interactions: saves, skips, dislikes, similar-works taps, searches, colour and tag filters, opened sheets, scrubbing, fullscreen and zoom.
- Metadata of the works involved (id, source, room, tags, colours, type).
- A random install ID that stays on the device, so reports from one install can be linked over time. No name, email or phone number.
- App version and device model.

The data feeds the crowd priors in the ranking. Wording for the opt-in form and privacy policy is still to be written.

## How it works

- **App** (`index.html`, `js/`, `styles.css`): static ES modules, no build step. Ranks on the device from a few interest vectors learned from saves and feedback. Fetches only the data shards nearest those interests.
- **Pipeline** (`pipeline/`): pulls open-licensed works, gates them on rights, scores them and exports content-addressed shards to `data/pack/`. See `pipeline/README.md`.
- **iOS app** (`ios/`): the same web app in a `WKWebView`, with on-device captions through Apple's speech recogniser. Build with `xcodegen generate`.

Images, film and audio are loaded from the source institutions; this repository holds metadata and attribution only.

## Run locally

```bash
python3 -m http.server 4410
```

## Sources

Met Open Access, Cleveland Museum of Art, Europeana, Project Gutenberg, Internet Archive. Only CC0, public domain and CC BY (and CC BY-SA for whole, unmodified images) are admitted.
