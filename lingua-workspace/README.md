# Lingua Workspace

LinguaStudio, ported into the vault — laid out as the v4 design
(`Lingua Workspace v4.dc.html`): a sidebar of **batches** and one main
pane, in your vault's own theme. The workspace sets no colours of its own;
every surface is an Obsidian CSS variable, so a translucent theme over a
wallpaper stays translucent and a light theme stays light. Open it from the
ribbon 🌐 or the command palette (the "Lingua" workspace layout is healed
if deleted).

## The sidebar

- **LINGUA · + · ↻** — new batch; sync Anki (AnkiConnect → AnkiWeb).
- **Language menu** — search, grouped by script, with each language's
  batch count. Everything below follows the chosen language.
- **Inbox · Review · Card Studio · New batch · Stats · Manage**
- **Batches** — this language's batches; *N to check* until every word is
  complete. Right-click: open, skim, duplicate, delete.
- **Stacks** — batches in study order, one deck with numbered subdecks.
- **Tools** — Dictionary, Sentences, Builders, Import & OCR.
- Backend dots (vault sidecar, engine) and the Lingua doctor.

## A batch: one word list → many card types

Header: the name (edit in place), where the words came from, **Export
.apkg** and **Push N cards**, then tiles for words, card types, cards and
words to check.

1. **Words** — a sheet: word, pinyin/reading, meaning, example, audio,
   status. Type words and press Enter: each is looked up (reading, meaning —
   a sense picker when the dictionary gives several — example sentence,
   audio). **Fill column** fills examples, meanings, audio, or Traditional +
   Zhuyin for the whole batch or the selected rows. **Find & replace**,
   **Rules** (if the word has more than N characters / comes from a source /
   has several senses / has no audio / has a third tone → skip a template,
   use a theme, add a tag, keep the first sense), flag filters (missing
   field, several senses, no audio, check capture), and a selection bar
   (set a field, look up again, remove). Right-click a word: play, look up
   again, find an image, relate it to another saved term.
2. **Card types** — batch defaults (the card themes learners may pick with a
   ★ default, the deck, accessibility defaults; copy all of it from another
   batch), then each card type made from these words: its templates, the
   field mapping, what's missing, its own themes, its subdeck. Card types
   are offered by language (Vocab for Mandarin, Word for every other
   language, tones for Mandarin/Cantonese, stroke order for Han scripts).
3. **Skim** — every card as a small preview in its theme. Click or Space
   flips, ← → move, X skips. *This card only*: include it or not, its theme,
   and per-card field edits that leave the word and its other cards alone.

### Getting words in — New batch

Paste or type · a frequency list (HSK levels for Mandarin) · from vault
notes (the Inbox, plus the inventory's words not yet in Anki) · Boox /
photo highlights (OCR; every word is flagged *Check capture* until
confirmed) · an existing Anki deck (AnkiConnect). Words added to a batch
are also recorded in the shared vocabulary CSV (an upsert — merge, never a
duplicate).

## The other screens

- **Inbox** — words captured from notes, the dictionary or sentences. Move
  the selected ones into a batch (looked up on the way) or save them to the
  `Vocabulary — <lang>` document and their vocab notes without making cards.
- **Card Studio** — the card families (Words, Sets, Sentences, Planned):
  templates, fields, grading; add one to the open batch, or open its
  classic builder. *Template library* shows the engine's raw templates and
  composes one-off cards.
- **Review** — opens Reading Companion's Study view (one scheduler).
- **Stats** — your batches, and the vocabulary record's counts.
- **Manage** — Languages (dictionaries, sentence packs), Voices (TTS and
  its cache), Settings (backends, local AI, Anki, paths, density, doctor).
- **Builders** — every classic builder form (sentence, dialogue, cloze,
  grammar…, and Cascade's two-mode builder), and stacks of their batches.

## Export and push

Push and export go to the LinguaStudio engine's v2 family route when it
answers (`/families/push`, `/families/export` — themes, accessibility flags
and per-template skips ride along). Until then the batch goes through the
classic routes the engine has always had: `/vocab/push` and the vault
sidecar's `/vocab/export` for Vocab, Word and Visual cards (words grouped by
the templates they keep), and `/push|export/<builder>` for the others.
Anything a classic route can't carry is said once, never silently dropped.
After either, the words are marked exported so the inventory shows ✓.

## Two backends

| Backend | Default | Owns |
|---|---|---|
| Vault sidecar | `:8749` | Storage, inventory and the exported flag, lookups (`/translate/word`), audio, TTS, OCR, the vocab `.apkg` — and **supervision**: opening this workspace starts the engine below |
| LinguaStudio engine | `:8000` | Card building, dictionary search, sentence corpus, AI cloze, images, genanki, AnkiConnect |

Each degrades on its own, and every failure names the missing server and the
fix. Long operations show in the busy chip at the top right; the engine is
kept alive while any run.

## Upgrading from 2.x

The 15-tab layout is gone. Old saved views open on the matching screen
(Capture and Anki → Inbox, TTS → Manage › Voices, Settings → Manage ›
Settings). Word lists from the old Vocab builder become a batch named
*Vocabulary · <language>* on first load. Classic builder batches are
untouched under Tools → Builders. The workspace theme setting is gone —
card themes are chosen per batch.

## Regenerating the card registry

The classic builder forms are extracted from LinguaStudio's own source:

```sh
node tools/extract-specs.js ~/dev/lingua-studio specs.json
```

then merge the output into `CARD_REGISTRY` in `main.js`.

## Tests

```sh
node .obsidian/plugins/lingua-workspace/test/run.js
```

Headless, no Obsidian, no network: the batch model, the screens'
view-models (card previews, the language menu, gloss and pinyin parsing,
Zhuyin, summaries), the export translation, stacks and routing.
