# Lingua Workspace

LinguaStudio, ported into the vault — in LinguaStudio's own look. One
native **Lingua** workspace (ribbon 🌐 / command palette, healed if
deleted) carries the complete card-creation suite, styled with the
app's design tokens (**sumi** by default; washi, konstrukt, soviet, and
terminal selectable in settings). You never open the LinguaStudio app:

- **Capture** — term → lookup → pending list → save to the append-only
  `Vocabulary — <lang>` documents, with rhythm units and per-term vocab
  notes (they carry the exported-to-Anki flag behind the inventory's ✓).
- **Vocab** — the flagship builder: one word list, several Anki card
  templates at once (Meaning / Reading / Listening / Writing / Cloze Fill,
  plus opt-in Visual). Dictionary-enriched, audio auto-resolved; export or
  push builds every selected template per word.
- **Dictionary** — full dictionary search; HSK sort/filter for Mandarin.
- **Cloze** — one AI cloze via the local model; batches in the Custom
  Cloze builder.
- **Builders** — every builder the current app surfaces (37), in the
  app's own nav groups: Core, Cloze, Skill, Composite, Output, Visual,
  Depth, Tools, Source — with the app's per-language gating (Rhythm and
  Tone Drill for Mandarin, Hanzi Writer for CJK, and so on). Each form
  is generated from the app's own composite definitions,
  field-for-field; retired card types don't appear. Batches persist per
  card type and survive restarts. Preview in Anki, push, or export
  `.apkg`. **Cascade** is the app's full two-mode builder — metronome
  word-flash (pattern · meter · speak-on-beats · writing) and timed
  reading — serializing the same BeatConfig the card template consumes.
- **Card Studio** — the real Anki templates behind every model: fields,
  front/back HTML, styling; compose a one-off card and push or export it.
- **Sentences** — example-sentence lookup from the installed corpus; send
  a sentence into a builder, the Capture list, or a cloze in one click.
- **TTS** — LinguaStudio's text-to-speech: pick a voice, preview it, and
  manage the audio cache the builders draw from.
- **Manage** — install more languages: download or import dictionaries and
  example-sentence packs, with live progress, or remove them.
- **Tools** — Import (paste a list → any builder), OCR (image → text →
  lines into any builder), image search, and stack export (several
  batches → one `.apkg` with ordered subdecks).
- **Settings** — theme + density, backend URLs and auto-start, Local AI
  (URL/model + connection check), Anki deck prefix and `.apkg` folder,
  paths, and the doctor — all in the workspace.
- **Anki** — the vocabulary round-trip: push or export, then terms are
  marked exported and the inventory shows ✓.

## Two backends, both hands-off

| Backend | Default | Owns |
|---|---|---|
| Vault sidecar | `:8749` | Storage (language documents, inventory, export flags) — and **supervision**: opening this workspace starts the engine below, closing it stops it a few minutes later |
| LinguaStudio engine | `:8000` (started on demand) | Everything linguistic: dictionary, audio, cloze, all card builders, OCR, images, genanki, AnkiConnect |

Each half degrades independently, and every failure names the missing
server and the fix.

## Confinement & in-flight work

Every tool lives inside the workspace views — nothing leaks into notes or
the global palette beyond the open-workspace commands. Long operations
(export, push, OCR) are tracked in the header's working chip; while any
run, the engine is kept alive even if you close the views, and leaving
the workspace mid-operation raises a warning that the running actions may
be canceled. Batches are saved as you type, so nothing is ever lost to a
restart.

## Regenerating the card registry

The builder forms are extracted from LinguaStudio's own source. After the
app adds or changes a card type:

```sh
node tools/extract-specs.js ~/dev/lingua-studio specs.json
```

then merge the output into `CARD_REGISTRY` in `main.js` (the marker
comment shows where it lives).

## Doctor & tests

Nav rail → **Lingua doctor**: both backends, AnkiConnect, LinguaStudio's
dependency doctor, and a registry sanity check, in one copyable report.

```sh
node .obsidian/plugins/lingua-workspace/test/run.js
```
