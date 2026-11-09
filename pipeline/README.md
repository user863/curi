# Content pipeline

Pulls open-licensed content, gates it on rights, scores it on source signals, stores it in SQLite and exports the client packs in `data/pack/`.
No per-item picking: every card comes from a rule or a threshold in `config.json`.

```bash
python3 -m pipeline.run                      # all sources, adding only new works
python3 -m pipeline.run --only cleveland     # some sources
python3 -m pipeline.run --refresh --retire   # re-evaluate everything and retire works that no longer qualify
```

**Incremental by default.** The database keeps what earlier runs found. Adapters skip works it already holds before fetching or probing them, so a run only pays for new content, and because candidates are ranked best first, each run reaches deeper into every source. `take` and `max_per_group` mean "new works per run". Sources are committed one by one, so a long run can be stopped and resumed. Requests are spaced per host and probes run in parallel.

Same work, different source: a title+creator key catches duplicates across sources.

Python 3.9+, numpy for clustering at export, otherwise the standard library. Responses are cached in `pipeline/.cache/`, so reruns are quick. Delete it to refetch.

## Stages

1. **Pull** (`sources/`): one module per source returns candidate cards.
2. **Rights gate** (`rights.py`): admits a card only when `license`, `jurisdictions` and `derivativesOk` are all `yes`. Everything else is rejected and counted in the report.
3. **Quality** (`quality.py`): 0..1 score from source signals (downloads, ratings, on view at the Met, metadata completeness, passage prose features). Becomes the ranker's `quality` weight (1.0 to 1.4).
4. **Diversify** (`run.py`): best first, capped per group (department, author, decade, creator).
5. **Store** (`db.py`): upsert into `works.sqlite`. Dense integer ids are assigned once and never reused. A takedown is permanent.
6. **Export** (`export.py`): the client packs (below) plus `data/pipeline-report.json` (candidates, selected and rejected per source, by reason).

## API keys

Keys are read from the environment, then the macOS Keychain, then `pipeline/.env.local` (gitignored). They are sent as HTTP headers, never in URLs, so they stay out of the cache, logs and the pack.

```bash
security add-generic-password -a "$USER" -s commonplace-europeana-api-key -w
```

`-w` with no value prompts for the key without echoing it. Without a key, Europeana jobs skip themselves.

## Database

SQLite at `pipeline/works.sqlite` (gitignored; keep it, the ids live in it). The schema ports to Postgres + pgvector.

| Table | Holds |
|---|---|
| `work` | dense `id`, `uid` (`met:...`), source, type, category, room, quality, tone, `state` (published / retired / taken_down), `rev` |
| `work_card` | display fields: title, creator, date, note, institution, source URL |
| `work_media`, `work_text` | media URL, fallback, poster, excerpt window; passage body |
| `work_rights` | license, jurisdictions, derivatives (yes/no/unknown), verified by, gate, attribution |
| `work_source` | source id, collection, fetched at |
| `tag`, `work_tag` | normalized tags |
| `work_embedding` | 64-dim int8 vector, model name |

## Client packs (`data/pack/`): cluster-sharded, content-addressed

Works are grouped into clusters of about 128 similar works (k-means on the embeddings, numpy required for export).
Cluster assignments are stable: new works join the nearest existing cluster, so a rerun changes only the shards that received works. A full re-cluster happens only when the catalogue doubles.

| File | Holds | Loaded |
|---|---|---|
| `manifest.json` | revision, shard hashes, per-cluster category counts and mean quality, rooms, room tile previews, tombstones | At launch (53 KB at 100k works) |
| `centroids.<hash>.i8` | one 64-dim vector per cluster | At launch (50 KB at 100k) |
| `idx/<cluster>.<hash>.bin` | typed arrays for the cluster's works: ids, category, room, quality, embeddings (71 bytes per work) | The clusters nearest the user's interests |
| `cards/<cluster>.<hash>.json` | display fields | When a work from the cluster is shown |
| `detail/<cluster>.<hash>.json` | rights, source, spec rows | When Note opens |

Files are named by content hash, so they are immutable: the HTTP cache keeps them, and a new revision means the client fetches the manifest and only the shards whose hash changed (this replaces delta sync).

How the client picks clusters (`js/plan.js`): enough works per category to honour the category mix, the clusters nearest its interests, plus a few random ones for serendipity and as decoys. The server sees file requests only, never a profile.

Measured at 100,000 synthetic works (`node tools/bench_pack.mjs <url>`): 101 KB to open, 172 KB until the first cards, about 2.7 MB (uncompressed) for a 60-card session, against a 6.9 MB full index plus about 100 MB of cards. Picks take about 0.1 ms.

At 100,000 works the index is about 7 MB. Embeddings are a stand-in (feature hashing of tags, room and type); swap in CLIP/SigLIP or a text model without changing the format.

Take a work down: `python3 -m pipeline.takedown <uid>`. Clients block tombstoned ids on the next manifest load.

Generate a synthetic pack: `python3 tools/synth_pack.py 100000 <out> <db>`. Benchmark the ranker: `node tools/bench.mjs 100000`.

## Categories

The feed balances across four categories (images, text, film, audio), not across sources: within a category, sources compete on quality and interest only. Shares start equal and follow what the user saves, asks for more of, or rejects, with a 10% floor per category.

## Sources

| Source | Selection | Rights | Media |
|---|---|---|---|
| Met Open Access | Highlights per department, public domain, with image | CC0 flag from the API | Image URL, loaded by the app |
| Project Gutenberg (via Gutendex) | Most downloaded English books; best prose paragraphs by heuristic | All authors died in or before 1955 | Text in the catalog |
| Cleveland Museum of Art | CC0 with image; highlights and on-view works rank highest | `share_license_status` | Image URL, loaded by the app |
| Europeana (needs key) | Open licences only, steered by Europeana's themes (art, photography, fashion, archaeology, music), spread across providers; images under 3.5 MB, audio that streams from an offset | `rights` URL; share-alike only for whole images | Provider-hosted file |
| Openverse | Allowlisted museum sources; quality from resolution, creator, title, tags | `license` code, normalised | Provider-hosted file |
| Internet Archive: Prelinger, NASA films | Collection, most downloaded | Item `licenseurl` must be public domain / CC0 | Time-range excerpt of the original file |
| Internet Archive: newsreels, National Archives film | Collection, most downloaded | Same | Time-range excerpt |
| Internet Archive: LibriVox, NASA audio, old-time radio | Collection, most downloaded | Same | Time-range excerpt of the original file |

Adding an Internet Archive source is a block in `config.json`.

## Limits

- Licences are the sources' own claims. `verifiedBy` stays `unknown` until a person checks; the app shows this.
- Excerpt start is a fixed fraction or offset of the file. There is no scene or speech detection.
- Descriptions are the source's own, cleaned. They are not written for the feed.
- Popularity is a proxy for quality and favours old, well-known items.
- Cluster files are fetched whole: a first card in a cluster costs that cluster's card shard (about 77 KB at 128 works, before gzip).
- `overrides.json` can pin a note, tone, room, tags or quality for an id. It is optional and empty of effect for ids that are not selected.
- Gutendex is a third-party mirror of the Gutenberg catalogue.
