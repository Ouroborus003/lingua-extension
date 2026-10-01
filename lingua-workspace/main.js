/*
Lingua Workspace — LinguaStudio, ported into the vault.

What it is
  - Laid out as the v4 design (Lingua Workspace v4.dc.html): a sidebar of
    word batches (LinguaNavView) and one main pane (LinguaMainView) whose
    batch screen turns one word list into many card types — Words, Card
    types, Skim — plus Inbox, Card Studio, Review, Stats, Manage, Stacks
    and the classic tools. It wears the vault's theme: styles.css uses
    Obsidian's CSS variables only.
  - The complete card-creation suite as a native workbench: every card type
    LinguaStudio can build — all 44 in its contract registry, from vocab
    and cloze through cascade, tone drills, matching games and social
    scripts — plus Card Studio, OCR, image search, and stack
    export. No webview; nothing linguistic re-implemented in JS.
  - Two Python backends do the real work:
      · the vault sidecar (:8749) owns storage (append-only language
        documents, inventory, the exported-Anki round-trip), TTS synthesis
        (edge-tts's neural voices — /tts/* and /vocab/audio, no
        LinguaStudio process required), the vocab .apkg export
        (/vocab/export, same story — no LinguaStudio process required),
        and supervises the engine below — opening this workspace starts
        it, closing the workspace lets it stop;
      · the LinguaStudio sidecar (:8000) owns the rest of language logic —
        dictionary, lookup, AI cloze, genanki, AnkiConnect, OCR, images,
        and the card contract registry this UI is generated from.
  - CARD_REGISTRY below is extracted from LinguaStudio's own builder
    composites (FIELDS/COLUMNS/deck defaults) and contract transforms, so
    the forms here match the app's forms field-for-field. Regenerate with
    tools/extract-specs.js after LinguaStudio adds a card type.

Confinement & in-flight work
  - Every tool lives inside this workspace's views — no global commands
    beyond opening the workspace, nothing leaks into notes.
  - Builder batches persist per card type in data.json, so nothing typed
    is ever lost to a restart or a workspace switch.
  - Long operations (export, push, OCR, prefetch) are tracked; while any
    are running the engine keepalive continues even with the views closed,
    and leaving the workspace mid-operation raises a warning that the
    actions still running may be canceled.

Hand-written (not bundled) so it stays readable and editable in place,
like the other vault-owned plugins.
*/

"use strict";

const obsidian = require("obsidian");

const MAIN_VIEW = "lingua-workspace-main";
const NAV_VIEW = "lingua-workspace-nav";
const WORKSPACE_NAME = "Lingua";
const KEEPALIVE_MS = 60 * 1000;

const DEFAULT_SETTINGS = {
    vaultSidecarUrl: "http://127.0.0.1:8749",
    linguaSidecarUrl: "http://127.0.0.1:8000",
    ankiConnectUrl: "http://127.0.0.1:8765",
    autoStartBackend: true,
    defaultLang: "zh",
    deckPrefix: "LinguaStudio",
    createVocabNotes: true,
    vocabNoteFolder: "01 Notes/linguistics/Vocab",
    generatedFolder: "08 Meta/Generated",
    apkgDir: "",           // empty = ~/Downloads
    density: "comfortable", // comfortable | compact — the workspace otherwise wears the vault's theme
    aiUrl: "",             // blank = engine auto-probes Ollama/LM Studio
    aiModel: "",           // blank = first installed model
    // TTS runs in the vault sidecar (app/tts_engine.py) — never LinguaStudio,
    // which owns dictionary/cloze/card-building but not synthesis. These are
    // just the TTS tab's starting point; changing engine/voice there doesn't
    // require opening Settings.
    ttsDefaultEngine: "edge",  // "edge" | "piper" | "gtts"
    ttsDefaultVoice: "",       // remembered voice id for that engine, "" = pick on load
};

/* ------------------------------------------------------------------ */
/* language registry — vault codes mapped to LinguaStudio's.           */
/* ------------------------------------------------------------------ */
const LANGS = [
    { vault: "zh", lingua: "cmn", name: "Mandarin", rtl: false },
    { vault: "zh-hans", lingua: "cmn", name: "Chinese (Simplified)", rtl: false },
    { vault: "zh-hant", lingua: "cmn", name: "Chinese (Traditional)", rtl: false },
    { vault: "yue", lingua: "yue", name: "Cantonese", rtl: false },
    { vault: "de", lingua: "deu", name: "German", rtl: false },
    { vault: "ar", lingua: "ara", name: "Arabic", rtl: true },
    { vault: "hu", lingua: "hun", name: "Hungarian", rtl: false },
    { vault: "es", lingua: "spa", name: "Spanish", rtl: false },
    { vault: "en", lingua: "eng", name: "English", rtl: false },
    { vault: "fr", lingua: "fra", name: "French", rtl: false },
    { vault: "ja", lingua: "jpn", name: "Japanese", rtl: false },
    { vault: "ko", lingua: "kor", name: "Korean", rtl: false },
    { vault: "ru", lingua: "rus", name: "Russian", rtl: false },
    { vault: "fa", lingua: "fas", name: "Persian", rtl: true },
    { vault: "pt", lingua: "por", name: "Portuguese", rtl: false },
    { vault: "it", lingua: "ita", name: "Italian", rtl: false },
    { vault: "nl", lingua: "nld", name: "Dutch", rtl: false },
    { vault: "pl", lingua: "pol", name: "Polish", rtl: false },
    { vault: "tr", lingua: "tur", name: "Turkish", rtl: false },
    { vault: "vi", lingua: "vie", name: "Vietnamese", rtl: false },
    { vault: "th", lingua: "tha", name: "Thai", rtl: false },
    { vault: "id", lingua: "ind", name: "Indonesian", rtl: false },
    { vault: "he", lingua: "heb", name: "Hebrew", rtl: true },
    { vault: "hi", lingua: "hin", name: "Hindi", rtl: false },
    { vault: "bn", lingua: "ben", name: "Bengali", rtl: false },
    { vault: "sw", lingua: "swa", name: "Swahili", rtl: false },
    { vault: "uk", lingua: "ukr", name: "Ukrainian", rtl: false },
    { vault: "cs", lingua: "ces", name: "Czech", rtl: false },
    { vault: "sv", lingua: "swe", name: "Swedish", rtl: false },
    { vault: "da", lingua: "dan", name: "Danish", rtl: false },
    { vault: "fi", lingua: "fin", name: "Finnish", rtl: false },
    { vault: "no", lingua: "nor", name: "Norwegian", rtl: false },
    { vault: "el", lingua: "ell", name: "Greek", rtl: false },
    { vault: "ro", lingua: "ron", name: "Romanian", rtl: false },
    { vault: "ca", lingua: "cat", name: "Catalan", rtl: false },
    { vault: "eu", lingua: "eus", name: "Basque", rtl: false },
];

/* Which tesseract pack OCRs a given vault language.
 *
 * This replaced `this.lang.vault === "zh" ? "chi_sim" : "eng"`, which was
 * wrong the moment LANGS grew subtags: picking "Chinese (Simplified)" from the
 * language menu yields vault code "zh-hans", which is NOT "zh", so Chinese
 * pages were OCR'd with the ENGLISH pack and came back as garbage with no
 * error. That is the exact failure this vault's CLAUDE.md forbids — never
 * compare a language code with === — and it is silent, which is why it sat
 * here undetected.
 *
 * Keyed on the BASE subtag so every zh-* variant lands on Chinese without
 * needing a row each. Tesseract has no Cantonese pack, so `yue` uses
 * Traditional Chinese, which is what its written form is.
 *
 * A language with no pack falls back to English deliberately: a wrong-script
 * result the operator can see beats an unhandled error, and the packs actually
 * installed here are ara/chi_sim/deu/eng/rus (sidecar /health). Adding a pack
 * to the box means adding a row here. */
const OCR_PACKS = {
    zh: "chi_sim", yue: "chi_tra", ja: "jpn", ko: "kor",
    ar: "ara", fa: "fas", he: "heb", hi: "hin", bn: "ben", th: "tha",
    ru: "rus", uk: "ukr", el: "ell",
    de: "deu", es: "spa", fr: "fra", it: "ita", pt: "por", nl: "nld",
    ca: "cat", ro: "ron", pl: "pol", cs: "ces", hu: "hun", tr: "tur",
    sv: "swe", da: "dan", no: "nor", fi: "fin",
    vi: "vie", id: "ind", sw: "swa", eu: "eus", en: "eng",
};

/* The part of a BCP-47 tag before the first hyphen, lowercased.
   "zh-hans" -> "zh", "ZH" -> "zh", "" -> "". Pure. */
function ocrBaseLang(code) {
    return String(code || "").toLowerCase().split("-")[0];
}

function ocrPackFor(code) {
    return OCR_PACKS[ocrBaseLang(code)] || "eng";
}

/* Is this vault language Mandarin, in any of its written forms?
 *
 * HSK is a Mandarin exam, so the HSK column and filter belong to zh AND its
 * subtags — but the checks were `this.lang.vault === "zh"`, which is false for
 * "zh-hans" and "zh-hant". A reader who picked "Chinese (Simplified)" from the
 * language menu silently lost the HSK column, with nothing to indicate why.
 * Cantonese is deliberately NOT included: yue has no HSK. */
function isMandarinLang(code) {
    return ocrBaseLang(code) === "zh";
}


function langByVault(code) {
    return LANGS.find((l) => l.vault === code) || LANGS[0];
}

/* ------------------------------------------------------------------ */
/* card registry — generated from LinguaStudio's composites/contracts. */
/* Do not hand-edit entries; regenerate with tools/extract-specs.js.   */
/* ------------------------------------------------------------------ */
const CARD_REGISTRY = {"groups":[{"name":"Core","types":["sentence_workshop","matching","sentence_scramble"]},{"name":"Cloze","types":["custom_cloze","passage_cloze","context_vocab"]},{"name":"Skill","types":["listening","pronunciation","rhythm","tone_drill","hanzi_writer"]},{"name":"Composite","types":["word_depth","grammar_accuracy","dialogue","qa_ladder"]},{"name":"Output","types":["shadowing","dictation","translation","writing_prompt","error_correction","dialogue_quiz","timed_recall","chunk_sequence"]},{"name":"Visual","types":["meaning_anchor","mnemonic"]},{"name":"Depth","types":["definition_drill","collocation","compound","syllable_tap","morpheme_matrix"]},{"name":"Tools","types":["visual_phoneme","chengyu","measure_word","radical_drill","pattern_rule"]},{"name":"Source","types":["cascade_reading","podcast"]}],"specs":{"sentence_workshop":{"title":"Sentences","description":"Full-sentence cards. Reading + translation + optional audio.","deck":"Studio::Sentences","primary":"sentence","fields":[{"key":"sentence","label":"Sentence","placeholder":"我喜欢喝咖啡。","multiline":true},{"key":"pinyin","label":"Reading","placeholder":"wǒ xǐhuān hē kāfēi"},{"key":"gloss","label":"Translation","placeholder":"I like to drink coffee."},{"key":"audio","label":"Audio","placeholder":"sentence.mp3"}],"columns":[{"key":"sentence","label":"Sentence","flex":2},{"key":"pinyin","label":"Reading","flex":2},{"key":"gloss","label":"Translation","flex":2}]},"matching":{"title":"Matching Game","description":"Match pairs across words, readings, translations — every word carries its full metadata, placed front or back as you choose.","deck":"Studio::Matching","primary":"left","fields":[{"key":"left","label":"Left side","placeholder":"cat"},{"key":"right","label":"Right side","placeholder":"gato"}],"columns":[{"key":"left","label":"Left","flex":1},{"key":"right","label":"Right","flex":1},{"key":"image","label":"Image","flex":1}]},"sentence_scramble":{"title":"Sentence Scramble","description":"Reorder jumbled words into correct sentences.","deck":"Studio::Scramble","primary":"sentence","fields":[{"key":"sentence","label":"Sentence","placeholder":"我喜欢学中文"},{"key":"gloss","label":"Translation","placeholder":"I like learning Chinese"}],"columns":[{"key":"sentence","label":"Sentence","flex":2},{"key":"gloss","label":"Translation","flex":2}]},"custom_cloze":{"title":"Cloze","description":"Cloze sentences with {{c1::…}} deletions — write them directly or paste from anywhere.","deck":"Studio::Cloze","primary":"cloze","fields":[{"key":"cloze","label":"Cloze sentence","placeholder":"我每天{{c1::打网球}}。","multiline":true},{"key":"gloss","label":"Gloss","placeholder":"I play tennis every day."}],"columns":[{"key":"cloze","label":"cloze"},{"key":"gloss","label":"gloss"}]},"passage_cloze":{"title":"Passage Cloze","description":"Fill blanks in longer passages. Context-rich cloze deletion.","deck":"Studio::PassageCloze","primary":"passage","fields":[{"key":"passage","label":"Passage (mark the blank with ___)","placeholder":"今天天气___好","multiline":true},{"key":"answer","label":"Answer (fills the ___ blank)","placeholder":"很"},{"key":"distractors","label":"Distractors (optional, comma-sep)","placeholder":"不, 太, 已经"}],"columns":[{"key":"passage","label":"Passage","flex":3},{"key":"answer","label":"Answer"},{"key":"distractors","label":"Distractors"}]},"context_vocab":{"title":"Context Vocab","description":"Vocabulary in context. Learn words within authentic passages.","deck":"Studio::ContextVocab","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"美丽"},{"key":"meaning","label":"Meaning","placeholder":"beautiful"},{"key":"passage","label":"Context Passage","placeholder":"这里的风景真美丽","multiline":true}],"columns":[{"key":"word","label":"Word"},{"key":"meaning","label":"Meaning"},{"key":"passage","label":"Context","flex":2}]},"listening":{"title":"Listening","description":"Audio-front cards. Listener must transcribe or translate.","deck":"Studio::Listening","primary":"audio","fields":[{"key":"audio","label":"Audio","placeholder":"cat.mp3"},{"key":"transcript","label":"Transcript","placeholder":"I like cats."},{"key":"translation","label":"Translation","placeholder":"optional"}],"columns":[{"key":"audio","label":"Audio Filename","flex":1.5},{"key":"transcript","label":"Transcript","flex":2},{"key":"translation","label":"Translation","flex":2}]},"pronunciation":{"title":"Pronunciation","description":"IPA + audio drills with shaping hints.","deck":"Studio::Pronunciation","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"thorough"},{"key":"ipa","label":"IPA","placeholder":"/ˈθʌɹə/"},{"key":"audio","label":"Audio","placeholder":"thorough.mp3"},{"key":"hints","label":"Hints","placeholder":"TH as in \"think\""}],"columns":[{"key":"word","label":"Word"},{"key":"ipa","label":"IPA"},{"key":"audio","label":"Audio"},{"key":"hints","label":"Hints","flex":2}]},"rhythm":{"title":"Rhythm","description":"Stress + cadence cards. Pattern drills for prosody.","deck":"Studio::Rhythm","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"北京"},{"key":"pattern","label":"Rhythm","placeholder":"—— • ——"},{"key":"meaning","label":"Meaning","placeholder":"Beijing"}],"columns":[{"key":"word","label":"Word"},{"key":"pattern","label":"Rhythm"},{"key":"meaning","label":"Meaning","flex":2}],"langs":["cmn","yue"]},"tone_drill":{"title":"Tone Drill","description":"Tonal contrast cards for CJK + tone-language learners.","deck":"Studio::Tones","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"妈麻马骂"},{"key":"syllable","label":"Syllable","placeholder":"mā má mǎ mà"},{"key":"tones","label":"Tones","placeholder":"1-2-3-4"},{"key":"audio","label":"Audio","placeholder":"tones.mp3"},{"key":"meaning","label":"Meaning","placeholder":"mother / hemp / horse / scold"}],"columns":[{"key":"word","label":"Word"},{"key":"syllable","label":"Syllable"},{"key":"tones","label":"Tones"},{"key":"meaning","label":"Meaning","flex":2}],"langs":["cmn","yue"]},"hanzi_writer":{"title":"Hanzi Writer","description":"Stroke-order practice cards. Uses HanziWriter.js on the card.","deck":"Studio::Hanzi","primary":"hanzi","fields":[{"key":"hanzi","label":"Hanzi","placeholder":"字"},{"key":"pinyin","label":"Pinyin","placeholder":"zì"},{"key":"meaning","label":"Meaning","placeholder":"character; word"},{"key":"radical","label":"Radical","placeholder":"宀"}],"columns":[{"key":"hanzi","label":"Hanzi"},{"key":"pinyin","label":"Pinyin"},{"key":"meaning","label":"Meaning","flex":2},{"key":"radical","label":"Radical"}],"langs":["cmn","yue","jpn","kor"]},"word_depth":{"title":"Word Depth","description":"Deep etymology + collocations + register. Beyond surface meaning.","deck":"Studio::WordDepth","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"run"},{"key":"definition","label":"Definition","placeholder":"to move quickly"},{"key":"collocations","label":"Collocations","placeholder":"run a marathon, run late","multiline":true}],"columns":[{"key":"word","label":"Word"},{"key":"definition","label":"Definition","flex":2},{"key":"collocations","label":"Collocations","flex":2}]},"grammar_accuracy":{"title":"Grammar","description":"Patterns with glosses, examples, and usage notes.","deck":"Studio::Grammar","primary":"rule","fields":[{"key":"rule","label":"Pattern","placeholder":"是 ... 的"},{"key":"formula","label":"Gloss","placeholder":"emphasis structure"},{"key":"examples","label":"Example","placeholder":"我是昨天来的。","multiline":true},{"key":"note","label":"Notes","placeholder":"usage notes","multiline":true}],"columns":[{"key":"rule","label":"Pattern"},{"key":"formula","label":"Gloss","flex":2},{"key":"examples","label":"Example","flex":2}]},"dialogue":{"title":"Dialogue","description":"Two-speaker exchanges with context and translation.","deck":"Studio::Dialogue","primary":"speakerA","fields":[{"key":"speakerA","label":"Speaker A","placeholder":"Hello."},{"key":"speakerB","label":"Speaker B","placeholder":"Hi, how are you?"},{"key":"context","label":"Context","placeholder":"casual greeting"},{"key":"translation","label":"Translation","placeholder":"EN gloss","multiline":true}],"columns":[{"key":"speakerA","label":"A","flex":2},{"key":"speakerB","label":"B","flex":2},{"key":"context","label":"Context"},{"key":"translation","label":"Translation","flex":2}]},"qa_ladder":{"title":"Q&A Ladder","description":"Four-stage knowledge ladder: recall, recognize, explain, apply.","deck":"Studio::QA::Ladder","primary":"question","fields":[{"key":"question","label":"Question","placeholder":"What is X?"},{"key":"answer","label":"Answer","placeholder":"…","multiline":true},{"key":"stage","label":"Stage","type":"select","options":[{"value":"recall","label":"Recall"},{"value":"recognize","label":"Recognize"},{"value":"explain","label":"Explain"},{"value":"apply","label":"Apply"}]},{"key":"tags","label":"Tags","placeholder":"tag1 tag2"}],"columns":[{"key":"question","label":"question"},{"key":"answer","label":"answer"},{"key":"stage","label":"stage"}]},"shadowing":{"title":"Shadowing","description":"Listen-and-repeat practice. Shadow native audio with delayed playback.","deck":"Studio::Shadowing","primary":"transcript","fields":[{"key":"transcript","label":"Transcript","placeholder":"跟我一起说","multiline":true},{"key":"audio","label":"Audio File","placeholder":"lesson01.mp3"},{"key":"delay","label":"Delay (s)","placeholder":"0.3","default":"0.3"}],"columns":[{"key":"transcript","label":"Transcript","flex":2},{"key":"delay","label":"Delay (s)"}]},"dictation":{"title":"Dictation","description":"Listen and transcribe. Audio playback with speed control.","deck":"Studio::Dictation","primary":"transcript","fields":[{"key":"transcript","label":"Transcript","placeholder":"今天天气很好"},{"key":"audio","label":"Audio File","placeholder":"dict01.mp3"},{"key":"speed","label":"Speed","placeholder":"1","default":"1"}],"columns":[{"key":"transcript","label":"Transcript","flex":2},{"key":"speed","label":"Speed"}]},"translation":{"title":"Translation","description":"Translate between L1 and L2. Bidirectional practice.","deck":"Studio::Translation","primary":"l1","fields":[{"key":"l1","label":"Source (L1)","placeholder":"Hello"},{"key":"l2","label":"Target (L2)","placeholder":"你好"}],"columns":[{"key":"l1","label":"Source (L1)"},{"key":"l2","label":"Target (L2)"}]},"writing_prompt":{"title":"Writing Prompt","description":"Free-writing prompts with model answers and word-count targets.","deck":"Studio::WritingPrompt","primary":"prompt","fields":[{"key":"prompt","label":"Prompt","placeholder":"Describe your morning routine","multiline":true},{"key":"model","label":"Model Answer","placeholder":"我每天早上...","multiline":true},{"key":"wc","label":"Word Count","placeholder":"60"}],"columns":[{"key":"prompt","label":"Prompt","flex":2},{"key":"wc","label":"Word Count"}]},"error_correction":{"title":"Error Correction","description":"Spot the mistake. Compare correct and incorrect sentences.","deck":"Studio::ErrorCorrection","primary":"correct","fields":[{"key":"correct","label":"Correct","placeholder":"我去了学校"},{"key":"incorrect","label":"Incorrect","placeholder":"我去学校了"},{"key":"why","label":"Explanation","placeholder":"Aspect marker placement"}],"columns":[{"key":"correct","label":"Correct"},{"key":"incorrect","label":"Incorrect"},{"key":"why","label":"Explanation","flex":2}]},"dialogue_quiz":{"title":"Dialogue Quiz","description":"Contextual dialogue response practice. Pick or produce the right reply.","deck":"Studio::DialogueQuiz","primary":"prompt","fields":[{"key":"prompt","label":"Prompt","placeholder":"你好吗?"},{"key":"context","label":"Context","placeholder":"Meeting a friend","multiline":true},{"key":"replies","label":"Replies (first = correct)","placeholder":"我很好\n我是好\n好好","multiline":true},{"key":"audio","label":"Audio File","placeholder":"dq01.mp3"}],"columns":[{"key":"prompt","label":"Prompt"},{"key":"context","label":"Context","flex":2}]},"timed_recall":{"title":"Timed Recall","description":"Exposure, delay, recall — with optional image and alarm.","deck":"Studio::Recall::Timed","primary":"word","fields":[{"key":"word","label":"Word"},{"key":"meaning","label":"Meaning"},{"key":"prompt","label":"Prompt","multiline":true},{"key":"image","label":"Image file"},{"key":"audio","label":"Audio file"},{"key":"exposure","label":"Exposure (s)","placeholder":"5"},{"key":"delay","label":"Delay (s)","placeholder":"30"},{"key":"alarm","label":"Alarm","type":"select","options":[{"value":"true","label":"On"},{"value":"false","label":"Off"}]},{"key":"tags","label":"Tags"}],"columns":[{"key":"word","label":"word"},{"key":"meaning","label":"meaning"},{"key":"exposure","label":"exposure"},{"key":"delay","label":"delay"}]},"chunk_sequence":{"title":"Chunk Sequence","description":"Step-by-step concept sequences. Ordered procedural learning.","deck":"Studio::ChunkSequence","primary":"name","fields":[{"key":"name","label":"Concept","placeholder":"Making tea"},{"key":"steps","label":"Steps (one per line)","placeholder":"Boil water\nAdd tea leaves\nSteep 3 minutes","multiline":true}],"columns":[{"key":"name","label":"Concept"},{"key":"steps","label":"Steps","flex":3}]},"meaning_anchor":{"title":"Meaning Anchor","description":"Visual meaning anchors. Word + image + example for deep encoding.","deck":"Studio::MeaningAnchor","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"海"},{"key":"meaning","label":"Meaning","placeholder":"sea"},{"key":"example","label":"Example","placeholder":"大海很美丽"},{"key":"image","label":"Image","placeholder":"sea.jpg"},{"key":"fade","label":"Fade Delay","placeholder":"1.5","default":"1.5"}],"columns":[{"key":"word","label":"Word"},{"key":"meaning","label":"Meaning"},{"key":"example","label":"Example","flex":2}]},"mnemonic":{"title":"Mnemonic","description":"Keyword + story memory anchors. Visual and narrative mnemonics.","deck":"Studio::Mnemonic","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"remember"},{"key":"meaning","label":"Meaning","placeholder":"to recall"},{"key":"keyword","label":"Keyword","placeholder":"member"},{"key":"story","label":"Story","placeholder":"A club member always remembers the rules","multiline":true},{"key":"image","label":"Image","placeholder":"mnemonic01.jpg"}],"columns":[{"key":"word","label":"Word"},{"key":"meaning","label":"Meaning"},{"key":"keyword","label":"Keyword","flex":2}]},"definition_drill":{"title":"Definition Drill","description":"Match words to definitions. Reverse vocabulary practice.","deck":"Studio::DefinitionDrill","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"ephemeral"},{"key":"description","label":"Definition","placeholder":"lasting a very short time"},{"key":"distractors","label":"Distractors","placeholder":"permanent, eternal"}],"columns":[{"key":"word","label":"Word"},{"key":"description","label":"Definition","flex":2}]},"collocation":{"title":"Collocation","description":"Word partnerships. Common collocations and natural pairings.","deck":"Studio::Collocation","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"make"},{"key":"chunks","label":"Collocations","placeholder":"phrase | pronunciation (optional) | meaning (optional)\nmake a decision\nmake progress | | to advance gradually","multiline":true}],"columns":[{"key":"word","label":"Word"},{"key":"chunks","label":"Collocations","flex":3}]},"compound":{"title":"Compound","description":"Break down compound words into component morphemes.","deck":"Studio::Compound","primary":"word","fields":[{"key":"word","label":"Compound","placeholder":"大学"},{"key":"meaning","label":"Meaning","placeholder":"university"},{"key":"parts","label":"Parts (char | gloss | role per line)","placeholder":"大 | big | modifier\n学 | study | head","multiline":true}],"columns":[{"key":"word","label":"Compound"},{"key":"meaning","label":"Meaning"},{"key":"parts","label":"Parts","flex":2}]},"syllable_tap":{"title":"Syllable Tap","description":"Tap out syllable boundaries. Phonological awareness drills.","deck":"Studio::SyllableTap","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"university"},{"key":"syllables","label":"Syllables (comma-sep)","placeholder":"u, ni, ver, si, ty"},{"key":"meaning","label":"Meaning","placeholder":"a place of higher education"},{"key":"audio","label":"Audio File","placeholder":"syllable01.mp3"}],"columns":[{"key":"word","label":"Word"},{"key":"syllables","label":"Syllables","flex":2},{"key":"meaning","label":"Meaning"}]},"morpheme_matrix":{"title":"Morpheme Matrix","description":"Prefix + root + suffix analysis. Morphological decomposition.","deck":"Studio::MorphemeMatrix","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"unhappiness"},{"key":"prefix","label":"Prefix · Meaning","placeholder":"un- · not"},{"key":"root","label":"Root · Meaning","placeholder":"happy · feeling joy"},{"key":"suffix","label":"Suffix · Meaning","placeholder":"-ness · state of"},{"key":"meaning","label":"Full Meaning","placeholder":"state of not being happy"}],"columns":[{"key":"word","label":"Word"},{"key":"prefix","label":"Prefix"},{"key":"root","label":"Root"},{"key":"suffix","label":"Suffix"}]},"visual_phoneme":{"title":"Visual Phoneme","description":"Visual + auditory phoneme pairing. See and hear sound patterns.","deck":"Studio::VisualPhoneme","primary":"word","fields":[{"key":"word","label":"Word","placeholder":"thought"},{"key":"phonemes","label":"Phonemes (comma-sep, fallback if no IPA)","placeholder":"th, ough, t"},{"key":"ipa","label":"IPA (comma-sep, preferred)","placeholder":"θ, ɔː, t"},{"key":"audio","label":"Audio File","placeholder":"phoneme01.mp3"}],"columns":[{"key":"word","label":"Word"},{"key":"phonemes","label":"Phonemes","flex":2},{"key":"ipa","label":"IPA","flex":2}]},"chengyu":{"title":"Chengyu","description":"Chinese four-character idioms. Origin, meaning, and usage.","deck":"Studio::Chengyu","primary":"idiom","fields":[{"key":"idiom","label":"Chengyu","placeholder":"一石二鸟"},{"key":"pinyin","label":"Pinyin","placeholder":"yī shí èr niǎo"},{"key":"meaning","label":"Meaning","placeholder":"kill two birds with one stone"},{"key":"literal","label":"Literal","placeholder":"one stone two birds"},{"key":"origin","label":"Origin","placeholder":"From a folk tale","multiline":true}],"columns":[{"key":"idiom","label":"Chengyu"},{"key":"pinyin","label":"Pinyin"},{"key":"meaning","label":"Meaning","flex":2}],"langs":["cmn"]},"measure_word":{"title":"Measure Word","description":"Chinese measure word drills. Noun + classifier pairings.","deck":"Studio::MeasureWord","primary":"noun","fields":[{"key":"noun","label":"Noun","placeholder":"书"},{"key":"measure","label":"Measure Word","placeholder":"本"}],"columns":[{"key":"noun","label":"Noun"},{"key":"measure","label":"Measure Word"}],"langs":["cmn"]},"radical_drill":{"title":"Radical Drill","description":"Chinese radical recognition. Identify radicals in characters.","deck":"Studio::RadicalDrill","primary":"radical","fields":[{"key":"radical","label":"Radical","placeholder":"氵"},{"key":"char","label":"Example Character","placeholder":"海"}],"columns":[{"key":"radical","label":"Radical"},{"key":"char","label":"Example Character"}],"langs":["cmn","yue","jpn"]},"pattern_rule":{"title":"Pattern Rule","description":"Grammar pattern rules with correct/incorrect examples.","deck":"Studio::PatternRule","primary":"rule","fields":[{"key":"rule","label":"Rule","placeholder":"把 + Object + Verb + 了"},{"key":"formula","label":"Formula","placeholder":"S + 把 + O + V + 了"},{"key":"examples","label":"Examples (✓/✗ prefix per line)","placeholder":"✓ 我把书看了\n✗ 我把了书看","multiline":true},{"key":"language","label":"Language","placeholder":"Mandarin","default":"Mandarin"}],"columns":[{"key":"rule","label":"Rule"},{"key":"formula","label":"Formula","flex":2}]},"cascade_reading":{"title":"Cascade","description":"Timed reading passages at a target pace.","deck":"Studio::Cascade","primary":"passage","fields":[{"key":"passage","label":"Passage","multiline":true},{"key":"word","label":"Focus word"},{"key":"title","label":"Title"},{"key":"wpm","label":"WPM","placeholder":"180"},{"key":"audio","label":"Audio file"},{"key":"tags","label":"Tags"}],"columns":[{"key":"title","label":"title"},{"key":"word","label":"word"},{"key":"wpm","label":"wpm"}]},"podcast":{"title":"Podcast","description":"Podcast scripts with audio — listening comprehension decks.","deck":"Studio::Podcast","primary":"title","fields":[{"key":"title","label":"Title"},{"key":"description","label":"Description","multiline":true},{"key":"script","label":"Script","multiline":true},{"key":"audio","label":"Audio file"},{"key":"tags","label":"Tags"}],"columns":[{"key":"title","label":"title"},{"key":"description","label":"description"}]}}};

// The app's own nav groups (src/App.jsx NAV_GROUPS), same names, same order.
const GROUP_ICONS = {
    "Core": "sprout",
    "Cloze": "brackets",
    "Skill": "ear",
    "Composite": "layers",
    "Output": "pen-line",
    "Visual": "image",
    "Depth": "ruler",
    "Tools": "wrench",
    "Source": "import",
};

function specFor(type) {
    return CARD_REGISTRY.specs[type] || null;
}

/* ------------------------------------------------------------------ */
/* pure helpers (exported for the headless tests)                      */
/* ------------------------------------------------------------------ */

function sanitizeFilename(name) {
    return String(name || "").replace(/[\\/:*?"<>|#^[\]]/g, "·").trim() || "untitled";
}

/* Stats section: count vocab-CSV rows by status. An unset/unrecognised
   status_receptive counts as "unknown" (never silently dropped from the
   total), matching the ladder the resolver itself declares
   (app/resolver.py RECEPTIVE_STATUSES) — a status this function has never
   seen is a resolver change, not a row worth losing count of. */
function summarizeVocabRows(rows) {
    const counts = { unknown: 0, seen: 0, learning: 0, known: 0 };
    let productive = 0, ignored = 0;
    for (const row of rows || []) {
        const s = row.status_receptive || "unknown";
        counts[s] = (counts[s] || 0) + 1;
        if (row.status_productive === "learning" || row.status_productive === "known") productive++;
        if (row.ignored === true || row.ignored === "true") ignored++;
    }
    return { total: (rows || []).length, ...counts, productive, ignored };
}

function entriesToExportBody(lang, entries, source) {
    return {
        language: lang.vault,
        source: String(source || "").trim(),
        entries: entries.map((e) => ({
            term: String(e.term || "").trim(),
            reading: String(e.reading || "").trim(),
            gloss: String(e.gloss || "").trim(),
            rhythm: rhythmLines(e.rhythm),
        })).filter((e) => e.term),
    };
}

function rhythmLines(raw) {
    if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
    return String(raw || "").split("\n").map((s) => s.trim()).filter(Boolean);
}

function clozeStrip(text) {
    return String(text || "").replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/g, "$1");
}

function parseInventoryUnexported(markdown) {
    const out = [];
    for (const line of String(markdown || "").split("\n")) {
        const m = line.match(/^\|\s*`([^`]+)`\s*\|[^|]*\|[^|]*\|([^|]*)\|/);
        if (m && !m[2].includes("✓")) out.push(m[1]);
    }
    return out;
}

function vocabNoteBody(entry, lang, source, today) {
    const esc = (s) => String(s || "").replace(/"/g, "'");
    // audio/traditional/zhuyin/image are per-entry, per-language optional —
    // most captures never set them, and a language without zhuyin/traditional
    // (German, say) has no business carrying an empty `zhuyin: ""` in every
    // note. Only emit the line when the entry actually has the value.
    const optional = (key) => {
        const v = String(entry[key] || "").trim();
        return v ? `${key}: "${esc(v)}"` : null;
    };
    return [
        "---",
        `created: ${today}`,
        "type: vocab",
        "domain: linguistics",
        `aliases: ["${esc(entry.term)}"]`,
        "tags: []",
        "generated: false",
        `language: ${lang.vault}`,
        `term: "${esc(entry.term)}"`,
        `first_seen: ${today}`,
        `source: "${esc(source)}"`,
        optional("traditional"),
        optional("zhuyin"),
        optional("audio"),
        optional("image"),
        "exported_anki: false",
        "---",
        `# ${entry.term}`,
        "",
        [entry.reading && `**Reading:** ${entry.reading}`,
         entry.gloss && `**Meaning:** ${entry.gloss}`].filter(Boolean).join("\n"),
        "",
    ].filter((line) => line !== null).join("\n");
}

// The vocab-note filename convention (an em dash, not a hyphen) — shared by
// note creation (ensureVocabNote) and the Anki round trip's frontmatter
// lookup (LinguaMainView.enrichFromNotes) so the two never drift apart. A
// second hand-typed copy of this format is exactly how a note goes silently
// unfound: wrong dash, "file not found", empty fields, no error anywhere.
function vocabNotePath(folder, langVault, term) {
    return `${folder}/${langVault} — ${sanitizeFilename(term)}.md`;
}

function wordsForPush(entries) {
    return entries.map((e) => ({
        word: String(e.term || "").trim(),
        trans: String(e.reading || "").trim(),
        meaning: String(e.gloss || "").trim(),
        audio: String(e.audio || "").trim(),
        traditional: String(e.traditional || "").trim(),
        zhuyin: String(e.zhuyin || "").trim(),
        image: String(e.image || "").trim(),
    })).filter((w) => w.word);
}

// wordsForPush only maps whatever an entry already carries — this is the
// impure-adjacent decision of *where else* to look before falling back to
// "". Prefer the entry's own in-memory value (this session's capture);
// otherwise fall back to the vocab note's frontmatter, the one place in the
// vault an operator can hand-attach traditional/zhuyin/image today. Never
// overwrite a value the entry already has.
function mergeNoteFields(entry, frontmatter) {
    const out = Object.assign({}, entry);
    const fm = frontmatter || {};
    for (const key of ["audio", "traditional", "zhuyin", "image"]) {
        if (!out[key] && fm[key]) out[key] = fm[key];
    }
    return out;
}

// runAnki resolves inventory picks through /translate/word one term at a
// time; a per-term network failure there used to be swallowed into a blank
// {reading:"", gloss:""} shell with nothing said about it — if the vault
// sidecar is up but flaky, or drops mid-loop, the push or export can still
// succeed and report "Pushed N note(s)" while some of them are silently
// empty. Surface the count once, after the loop, instead of per term.
// Mode-neutral wording on purpose: this fires before the push/export branch
// even runs, so it must not assert "pushed" when the operator chose Export
// (or when the failure is the sidecar being fully down — nothing gets
// pushed at all, and this Notice shouldn't claim it did).
function lookupFailureNotice(failedCount, totalCount) {
    if (!failedCount) return "";
    return `${failedCount} of ${totalCount} term(s) couldn't be looked up just `
        + "now — carried through with blank reading/meaning.";
}

// A fresh row draft for a spec: defaults, first select option, else "".
function draftFromSpec(fields) {
    const d = {};
    for (const f of fields || []) {
        d[f.key] = f.default != null ? String(f.default)
            : (f.type === "select" && f.options && f.options.length
                ? String(f.options[0].value) : "");
    }
    return d;
}

// Strip UI-internal keys before a row goes to the engine.
function batchPayload(rows) {
    return (rows || []).map((r) => {
        const out = {};
        for (const k of Object.keys(r)) if (!k.startsWith("_")) out[k] = r[k];
        return out;
    });
}

// OCR/import helper: one line of text -> one row, into the primary field.
function linesToRows(text, spec) {
    const primary = spec.primary
        || (spec.fields && spec.fields[0] && spec.fields[0].key);
    if (!primary) return [];
    return String(text || "").split("\n").map((s) => s.trim()).filter(Boolean)
        .map((line) => Object.assign(draftFromSpec(spec.fields), { [primary]: line }));
}

/* ------------------------------------------------------------------ */
/* v4 batch logic — pure model for the word-batch workbench.           */
/*                                                                     */
/* Lingua Workspace v4 (scratchpad/anki-ds/Lingua Workspace v4.dc.html)*/
/* replaces the 15-section tab bar with a sidebar of batches: each     */
/* batch holds a word list, a set of card-type outs built from those   */
/* words, batch themes/deck/flags, per-word rules, and per-card        */
/* overrides. Inbox, Stacks and Card Studio are unchanged.             */
/*                                                                     */
/* Everything here is pure (no Obsidian, no network) so the headless   */
/* tests can reach it directly. The DOM screens render these values;   */
/* they never recompute them.                                          */
/*                                                                     */
/* Word shape: {id,S,P,M,senses[],T,Z,Sent,SP,ST,audio,src,conf,tags[]} */
/*   S = the word itself; P = reading (pinyin/IPA/kana…); M = meaning  */
/*   ("" when several senses are unpicked); senses = candidate meanings;*/
/*   T/Z = Traditional/Zhuyin (CJK); Sent/SP/ST = example + readings;  */
/*   audio = "" (none) or a source label ("Forvo","TTS",…); src = where */
/*   the word came from ("HSK 3","Boox","Typed",…); conf = capture      */
/*   confidence 0..1 (OCR/Boox highlights may be < 1); tags = word tags.*/
/*   Optional: audioFile = the cached clip's filename (from /vocab/audio),*/
/*   image = a media filename for Visual cards.                        */
/* Batch shape: {id,name,source,words[],outs[],themes[],def,deck,flags{},*/
/*   rules[{id,on,cond,val,act,aval}],ov{cardKey:{inc,theme,f{}}}}       */
/*   outs[] entries: {type,tpls[],themes|null,def|null,sub} — tpls are  */
/*   indexes into the WT type's template list; themes/def null = inherit*/
/*   the batch default. ov maps a card key to {inc:0|1 (skip/include    */
/*   override), theme (per-card theme id), f (per-card field edits)}.   */
/* ------------------------------------------------------------------ */

const V4_FIELD_KEYS = { Word: "S", Pinyin: "P", Meaning: "M", Example: "Sent", "Example translation": "ST", Traditional: "T" };

const V4_FLAG_TXT = { missing: "Missing field", senses: "Several senses", audio: "No audio", conf: "Check capture" };

const V4_CONDS = [
    { id: "chars", label: "the word has more than", val: 1, unit: "characters" },
    { id: "src", label: "the source is", val: 1 },
    { id: "senses", label: "the word has several senses" },
    { id: "noaudio", label: "no audio was found" },
    { id: "tone3", label: "it has a third tone" },
];

const V4_ACTS = [
    { id: "skip", label: "skip the template" },
    { id: "theme", label: "use the theme" },
    { id: "tag", label: "add the tag" },
    { id: "sense1", label: "keep the first sense" },
];

/* Word-built card types: one note per word, except `group` types which pack
   N words per note (matching: 6 per board; cflash: 8 per cascade note).
   fields[] marks required engine fields with p:true (mirrors the v4 mock's
   `*` suffix). map is the human-readable field mapping shown in the UI. */
const V4_WT = [
    { id: "vocab", name: "Vocab", desc: "Five templates per word", tpls: ["Meaning", "Reading", "Listening", "Writing", "Cloze Fill"], fields: [{ k: "Simplified", p: true }, { k: "Pinyin", p: true }, { k: "Meaning", p: true }, { k: "Traditional" }, { k: "Zhuyin" }, { k: "Sentence" }, { k: "SentencePinyin" }, { k: "SentenceTranslation" }], map: "All word fields" },
    { id: "tone", name: "Tone Drill", desc: "Tap the tone of each syllable", tpls: ["Tone Read", "Tone Listen"], fields: [{ k: "Word", p: true }, { k: "Pinyin", p: true }, { k: "Meaning" }], map: "Word ← Word · Pinyin ← Pinyin · Meaning ← Meaning" },
    { id: "hanzi", name: "Hanzi Writer", desc: "Stroke-order practice", tpls: ["Write"], fields: [{ k: "Hanzi", p: true }, { k: "Pinyin", p: true }, { k: "Meaning", p: true }], map: "Hanzi ← Word · Pinyin ← Pinyin · Meaning ← Meaning" },
    { id: "matching", name: "Matching Game", desc: "Six words per game", group: 6, tpls: ["Match", "Write & Match"], fields: [{ k: "Word", p: true }, { k: "Right side", p: true }], map: "Six words per note · Right side ← Meaning" },
    { id: "cflash", name: "Cascade · Flash", desc: "Words flash on the beat", group: 8, tpls: ["Flash"], fields: [{ k: "Words", p: true }, { k: "BPM", p: true }, { k: "Pattern", p: true }], map: "Eight words per note · 80 BPM · Cross" },
    { id: "dictation", name: "Dictation", desc: "Hear it, type it", tpls: ["Dictation"], fields: [{ k: "Audio", p: true }, { k: "Text", p: true }], map: "Audio ← Audio · Text ← Word" },
    { id: "timed", name: "Timed Recall", desc: "See it, wait, recall it", tpls: ["Recall"], fields: [{ k: "Item", p: true }, { k: "Exposure s", p: true }, { k: "Delay s", p: true }], map: "Item ← Word · 5 s exposure · 20 s delay" },
    { id: "concept", name: "Concept", desc: "Recall and reverse, e.g. chengyu or compounds", tpls: ["Recall", "Reverse"], fields: [{ k: "Front", p: true }, { k: "Back", p: true }, { k: "Reading" }], map: "Front ← Word · Back ← Meaning · Reading ← Pinyin" },
    { id: "word", name: "Word", desc: "Other languages: meaning, reading, listening, writing", tpls: ["Meaning", "Reading", "Listening", "Writing"], fields: [{ k: "Word", p: true }, { k: "Meaning", p: true }, { k: "Reading" }], map: "Word ← Word · Meaning ← Meaning · Reading ← Pinyin" },
    { id: "visual", name: "Visual Cards", desc: "Picture ↔ word", tpls: ["Recognition", "Writing"], fields: [{ k: "Word", p: true }, { k: "Image", p: true }, { k: "Meaning", p: true }], map: "Word ← Word · Image ← Image · Meaning ← Meaning" },
];

/* WT type -> engine card family (linguastudio/assets/cards dir name).
   `timed` has no v2 family: Timed Recall was folded into the Memory setting
   (WriteCfg memMode, migration-map §3), so it cannot be exported yet. */
const V4_WT_TO_FAMILY = {
    vocab: "LinguaStudio",
    tone: "LinguaStudio_Tone_Drill",
    hanzi: "LinguaStudio",
    matching: "LinguaStudio_Matching_Game",
    cflash: "LinguaStudio_Cascade_Flow",
    dictation: "LinguaStudio_Sentence",
    concept: "LinguaStudio_Concept",
    word: "LinguaStudio_Word",
    visual: "LinguaStudio_Visual_Cards",
};

/* WT template index -> engine family template name. Most match 1:1; the
   short mock names below are expanded to the real template names so the
   engine's skip list (template names, not indexes) lines up. */
const V4_TPL_TO_FAMILY_TPL = {
    vocab: ["Meaning", "Reading", "Listening", "Writing", "Cloze Fill"],
    tone: ["Tone Read", "Tone Listen"],
    hanzi: ["Writing"],
    matching: ["Matching Game", "Write And Match"],
    cflash: ["Cascade Flow"],
    dictation: ["Dictation"],
    concept: ["Recall", "Reverse"],
    word: ["Meaning", "Reading", "Listening", "Writing"],
    visual: ["Visual Recognition", "Visual Writing"],
};

function v4Wt(id) {
    return V4_WT.find((t) => t.id === id) || null;
}

/* Which word-batch card types make sense for a language: Vocab (Simplified
   + Pinyin) is Mandarin's; tones are Mandarin's and Cantonese's; stroke
   order needs a Han script; Word is every other language's vocab note.
   Base subtags, never ===. */
const V4_WT_LANGS = { vocab: ["zh"], tone: ["zh", "yue"], hanzi: ["zh", "yue", "ja"] };
function v4TypeAvailable(typeId, vault) {
    const base = ocrBaseLang(vault || "zh");
    if (typeId === "word") return base !== "zh";
    const only = V4_WT_LANGS[typeId];
    return !only || only.includes(base);
}

/* Ids outlive the session (batches persist, and per-card overrides are keyed
   by word id), so a bare counter restarting at the same number on every load
   would hand a new word the id of a saved one. Time + counter, base 36: unique
   across sessions, short, and never containing ":" (card keys use it). */
let _v4Uid = 0;
function v4NextId(prefix) {
    _v4Uid += 1;
    return (prefix || "w") + Date.now().toString(36) + _v4Uid.toString(36);
}

/* Fresh word with mock-free defaults. No demo dictionary lives here: callers
   fill P/M/senses via lookup (CC-CEDICT etc.). conf defaults to 1 (typed);
   OCR/Boox captures pass their own confidence. */
function v4MakeWord(S, o) {
    const w = { id: v4NextId("w"), S: String(S || ""), P: "", M: "", senses: [], T: "", Z: "", Sent: "", SP: "", ST: "", audio: "", src: "Typed", conf: 1, tags: [] };
    return Object.assign(w, o || {});
}

/* Fresh batch: one vocab out (all five templates), a small theme set with a
   default, and no words — the New-batch modal fills name/lang/source, the
   Words tab fills the rest. Pure (id comes from the shared counter). */
function v4NewBatch(name, langVault, source) {
    const lang = langVault || "zh";
    // Mandarin starts from the five-card Vocab note; every other language
    // from Word, the one note type that carries its Language profile.
    const out = isMandarinLang(lang)
        ? { type: "vocab", tpls: [0, 1, 2, 3, 4], themes: null, def: null, sub: "Vocab" }
        : { type: "word", tpls: [0, 1, 2, 3], themes: null, def: null, sub: "Word" };
    return { id: v4NextId("b"), name: String(name || "New batch"), lang,
        source: source || "Typed", words: [],
        outs: [out],
        themes: ["sumi", "washi"], def: "sumi", deck: "LinguaStudio",
        flags: {}, rules: [], ov: {} };
}

/* _ls_lang.js codes accepted in a Word/Concept Language field. Vault codes
   match 1:1 except Mandarin/English (no entry → "xx" generic voice) and
   zh subtags (zh-hans → zh → xx). Matched on the base subtag — never ===. */
const V4_LS_LANGS = ["ar", "fa", "ur", "nl", "fr", "de", "hu", "it", "pl", "pt", "ru", "es", "tr", "ja", "ko", "yue"];

function v4WordLang(vaultCode) {
    const base = String(vaultCode || "").toLowerCase().split("-")[0];
    return V4_LS_LANGS.includes(base) ? base : "xx";
}

/* Audio filename convention: the sidecar audio_provider caches the canonical
   clip as <lingua>-<word>.mp3 under ~/LinguaStudio/audio, which is where
   family_export resolves [sound:…] media. So a word carrying any audio source
   label emits [sound:<lingua>-<word>.mp3] — real after TTS synthesis, dangling
   before it (same as the app: export after resolving audio). */
function v4AudioTag(w, batch) {
    if (!w.audio) return "";
    // The sidecar's /vocab/audio answers the cached filename; when the word
    // carries one, that is the file — no need to re-derive the convention.
    if (w.audioFile) return "[sound:" + w.audioFile + "]";
    const lingua = (langByVault(batch.lang || "zh") || {}).lingua || "xx";
    return "[sound:" + lingua + "-" + w.S + ".mp3]";
}

/* Pinyin diacritic -> tone number (1-4, else 5/neutral). ES5-safe. */
function v4ToneOf(s) {
    const x = String(s || "");
    if (/[āēīōūǖ]/.test(x)) return 1;
    if (/[áéíóúǘ]/.test(x)) return 2;
    if (/[ǎěǐǒǔǚ]/.test(x)) return 3;
    if (/[àèìòùǜ]/.test(x)) return 4;
    return 5;
}

/* Word flags: what needs a look before this word can make cards.
   `missing` = no reading, or no meaning and no unpicked senses to choose
   from. `senses`/`audio`/`conf` are independent of `missing`. Pure. */
function v4FlagsOf(w) {
    const f = [];
    if (!w.P || (!w.M && !((w.senses || []).length > 1))) f.push("missing");
    if ((w.senses || []).length > 1 && !w.M) f.push("senses");
    if (!w.audio) f.push("audio");
    if ((w.conf == null ? 1 : w.conf) < 0.8) f.push("conf");
    return f;
}

function v4CondHit(r, w) {
    if (!r) return false;
    if (r.cond === "chars") return [...String(w.S || "")].length > (parseInt(r.val, 10) || 0);
    if (r.cond === "src") return String(w.src || "").toLowerCase() === String(r.val || "").toLowerCase();
    if (r.cond === "senses") return (w.senses || []).length > 1;
    if (r.cond === "noaudio") return !w.audio;
    if (r.cond === "tone3") return String(w.P || "").split(/\s+/).some((s) => v4ToneOf(s) === 3);
    return false;
}

function v4RuleText(r) {
    const c = V4_CONDS.find((x) => x.id === r.cond) || { label: r.cond };
    const a = V4_ACTS.find((x) => x.id === r.act) || { label: r.act };
    const condPart = "If " + c.label + (c.val ? " " + (r.val || "") + (c.unit ? " " + c.unit : "") : "");
    if (r.act === "skip") return condPart + ", " + a.label + ' "' + (r.aval || "") + '"';
    if (r.act === "theme") return condPart + ", " + a.label + " " + (r.aval || "");
    if (r.act === "tag") return condPart + ", " + a.label + " #" + (r.aval || "");
    return condPart + ", " + a.label;
}

/* Effective meaning: the word's picked meaning, or the first sense when a
   live sense1 rule fires for this word. Never mutates. */
function v4EffMeaning(w, batch) {
    if (w.M) return w.M;
    if ((w.senses || []).length > 1 && (batch.rules || []).some((r) => r.on && r.act === "sense1" && v4CondHit(r, w))) return w.senses[0];
    return w.M;
}

/* Full card list for a batch: one entry per (out x template x word-or-group).
   Group types (matching/cflash) pack N words per note ({ws}); the rest carry
   {w}. Each card carries its rule verdict (ruleSkip text, ruleTheme id, tags)
   so skipped()/themeOf()/rowFor() stay trivial. Pure. */
function v4Cards(batch) {
    const out = [];
    (batch.outs || []).forEach((o, oi) => {
        const t = v4Wt(o.type);
        if (!t) return;
        const groups = t.group
            ? Array.from({ length: Math.ceil((batch.words || []).length / t.group) },
                (_, g) => (batch.words || []).slice(g * t.group, g * t.group + t.group))
            : null;
        (o.tpls || []).forEach((ti) => {
            if (groups) {
                groups.forEach((ws, gi) => {
                    if (!ws.length) return;
                    out.push({ key: oi + ":g" + gi + ":" + ti, oi, ti, t, o, ws, label: t.name + " " + (gi + 1), ruleSkip: "", ruleTheme: "", tags: [] });
                });
                return;
            }
            (batch.words || []).forEach((w) => {
                let ruleSkip = "", ruleTheme = "";
                const tags = [];
                (batch.rules || []).forEach((r) => {
                    if (!r.on || !v4CondHit(r, w)) return;
                    if (r.act === "skip" && t.tpls[ti] === r.aval) ruleSkip = v4RuleText(r);
                    if (r.act === "theme") ruleTheme = r.aval;
                    if (r.act === "tag") tags.push(r.aval);
                });
                out.push({ key: oi + ":" + w.id + ":" + ti, oi, ti, t, o, w, label: w.S + " · " + t.tpls[ti], ruleSkip, ruleTheme, tags });
            });
        });
    });
    return out;
}

/* Skip verdict: per-card override wins (inc 1 = force include, 0 = force
   skip); otherwise the rule verdict stands. */
function v4Skipped(batch, card) {
    const ov = (batch.ov || {})[card.key] || {};
    if (ov.inc === 1) return false;
    if (ov.inc === 0) return true;
    return !!card.ruleSkip;
}

/* Theme verdict: per-card override > rule theme > out default > batch
   default. Returns a theme id; callers resolve names elsewhere. */
function v4ThemeOf(batch, card) {
    const ov = (batch.ov || {})[card.key] || {};
    return ov.theme || card.ruleTheme || (card.o.themes ? card.o.def : batch.def);
}

/* Field mapping: card -> engine field row for its family. Per-card field
   edits (ov.f) layer over the word-derived base. Group notes map from ws;
   single-word notes map from w with the batch's effective meaning.
   Missing asset conventions: Audio is emitted as [sound:<word>.mp3] when the
   word carries any audio source label (the exporter resolves the file); the
   Word/Concept Language defaults to `wordLang` ("xx" = generic voice);
   Concept Kind defaults to "definition" (valid kinds: chengyu, radical,
   compound, mnemonic, definition, rule, morpheme, prompt); Cascade Flow
   ships 80 BPM / Cross pattern defaults. */
function v4RowFor(batch, card) {
    const ov = ((batch.ov || {})[card.key] || {}).f || {};
    const lang = v4WordLang(batch.lang);
    if (card.ws) {
        if (card.t.id === "matching") {
            const r = { SetID: batch.id };
            card.ws.forEach((w, i) => {
                const n = i + 1, M = v4EffMeaning(w, batch);
                r["Word" + n] = w.S;
                r["Meaning" + n] = M;
                r["Pinyin" + n] = w.P;
            });
            return Object.assign(r, ov);
        }
        if (card.t.id === "cflash") {
            return Object.assign({ Title: batch.name, Text: card.ws.map((w) => w.S).join(" "), Rate: "80", Pattern: "cross" }, ov);
        }
        return Object.assign({}, ov);
    }
    const w = card.w, M = v4EffMeaning(w, batch);
    let r;
    switch (card.t.id) {
        case "vocab":
            r = { Simplified: w.S, Pinyin: w.P, Meaning: M, Traditional: w.T, Zhuyin: w.Z, Sentence: w.Sent, SentencePinyin: w.SP, SentenceTranslation: w.ST, Audio: v4AudioTag(w, batch) };
            break;
        case "tone":
            r = { Simplified: w.S, Pinyin: w.P, Meaning: M, Audio: v4AudioTag(w, batch) };
            break;
        case "hanzi":
            r = { Simplified: w.S, Pinyin: w.P, Meaning: M, Audio: v4AudioTag(w, batch) };
            break;
        case "dictation":
            r = { Sentence: w.S, Audio: v4AudioTag(w, batch) };
            break;
        case "concept":
            r = { Kind: "definition", Front: w.S, Back: M, Reading: w.P, Language: lang, Audio: v4AudioTag(w, batch) };
            break;
        case "word":
            r = { Word: w.S, Meaning: M, Reading: w.P, Language: lang, Audio: v4AudioTag(w, batch), Sentence: w.Sent, SentenceTranslation: w.ST };
            break;
        case "visual":
            r = { Simplified: w.S, Traditional: w.T, Pinyin: w.P, Meaning: M, Image: w.image || "", Audio: v4AudioTag(w, batch) };
            break;
        case "timed":
            r = { Item: w.S, "Exposure s": "5", "Delay s": "20" };
            break;
        default:
            r = { Word: w.S, Image: "", Meaning: M };
            break;
    }
    return Object.assign(r, ov);
}

/* Engine family field lists (linguastudio/card_families.py fields.txt per
   family). The payload builder only emits keys present here — emitting an
   unknown field fails family_export validation (and would push empty). When
   the engine gains a field, add it here; the headless tests assert every
   v4RowFor key against this map so drift fails loudly, not silently. */
const V4_FAMILY_FIELDS = {
    LinguaStudio: ["Simplified", "Traditional", "Pinyin", "Zhuyin", "Meaning", "Audio", "Sentence", "SentencePinyin", "SentenceTranslation", "Tags", "Resources", "WriteCfg", "Image"],
    LinguaStudio_Tone_Drill: ["Simplified", "Traditional", "Pinyin", "Meaning", "Audio", "HSK", "SensoryMute", "DyslexiaMode", "MicroSteps", "MetronomeOverlay", "MetronomeBPM"],
    LinguaStudio_Matching_Game: ["Word1", "Image1", "Pinyin1", "Word2", "Image2", "Pinyin2", "Word3", "Image3", "Pinyin3", "Word4", "Image4", "Pinyin4", "Word5", "Image5", "Pinyin5", "Word6", "Image6", "Pinyin6", "SetID", "WriteCfg", "Meaning1", "Audio1", "Zhuyin1", "Traditional1", "IPA1", "Level1", "Meaning2", "Audio2", "Zhuyin2", "Traditional2", "IPA2", "Level2", "Meaning3", "Audio3", "Zhuyin3", "Traditional3", "IPA3", "Level3", "Meaning4", "Audio4", "Zhuyin4", "Traditional4", "IPA4", "Level4", "Meaning5", "Audio5", "Zhuyin5", "Traditional5", "IPA5", "Level5", "Meaning6", "Audio6", "Zhuyin6", "Traditional6", "IPA6", "Level6", "FieldCfg", "SensoryMute", "DyslexiaMode", "MicroSteps", "MetronomeOverlay", "MetronomeBPM"],
    LinguaStudio_Cascade_Flow: ["Title", "Text", "Rate", "Pattern", "Audio", "BeatConfig", "Meaning", "WriteCfg", "Metrics"],
    LinguaStudio_Sentence: ["Sentence", "Reading", "Translation", "Breakdown", "Audio", "AudioFile", "Words", "Title", "Level", "Language", "Source", "SensoryMute", "DyslexiaMode", "MicroSteps", "MetronomeOverlay", "MetronomeBPM"],
    LinguaStudio_Concept: ["Kind", "Front", "Reading", "Back", "Literal", "Hint", "Parts", "Details", "Example", "ExampleReading", "ExampleTranslation", "Notes", "Image", "Audio", "Language", "Reverse", "ReverseOnly", "Write", "Source", "SensoryMute", "DyslexiaMode", "MicroSteps", "MetronomeOverlay", "MetronomeBPM"],
    LinguaStudio_Word: ["Word", "Reading", "Meaning", "Audio", "Sentence", "SentenceReading", "SentenceTranslation", "Details", "Language", "Image", "Write", "WriteCfg", "SensoryMute", "DyslexiaMode", "MicroSteps", "MetronomeOverlay", "MetronomeBPM"],
    LinguaStudio_Visual_Cards: ["Simplified", "Traditional", "Pinyin", "Meaning", "Image", "Audio", "HSK", "Example", "WriteCfg", "SensoryMute", "DyslexiaMode", "MicroSteps", "MetronomeOverlay", "MetronomeBPM"],
};

/* Families whose notes carry a WriteCfg field — derived from the field
   lists above, never hand-maintained. */
const V4_WRITE_CFG_FAMILIES = Object.fromEntries(
    Object.entries(V4_FAMILY_FIELDS).filter(([, fs]) => fs.includes("WriteCfg")).map(([f]) => [f, 1]));

/* ND accommodation flags that ride as note fields (not WriteCfg) on the
   families that have them. */
const V4_ND_FLAGS = ["SensoryMute", "DyslexiaMode", "MicroSteps", "MetronomeOverlay"];

/* WriteCfg for a note: the card's theme allow-list + default. Mirrors the
   _ls_core.js contract — a note's WriteCfg `themes` (list) limits the theme
   picker and `theme` sets the default, while the learner's own device
   setting still wins. Batch/out defaults flow down; a per-card theme
   override replaces the default but keeps the allow-list. */
function v4WriteCfg(batch, out, cardTheme) {
    const allow = out.themes || batch.themes || [];
    const def = cardTheme || out.def || batch.def || "";
    const cfg = {};
    if (allow.length) cfg.themes = allow.slice();
    if (def) cfg.theme = def;
    return Object.keys(cfg).length ? JSON.stringify(cfg) : "";
}

/* Engine payload: batch -> family groups for family_export
   ({family, deck, notes:[{fields, tags, skip}]}). One group per out; deck is
   the batch deck plus the out's subdeck. skip holds engine template names
   (not WT indexes). Per-card overrides (skip/theme/fields) are honored;
   batch flags (SensoryMute…) ride as fields where the family has them, and
   the theme WriteCfg is filled where the family has a WriteCfg field.
   `deckRoot` (optional) replaces the batch deck — a stack files each batch
   under its own numbered subdeck.
   Returns {groups, errors}: `timed` (no v2 family) and unknown out types
   land in errors, never silently dropped. Pure. */
function v4BatchToFamilyGroups(batch, deckRoot) {
    const groups = [], errors = [];
    const all = v4Cards(batch);
    (batch.outs || []).forEach((o, oi) => {
        const t = v4Wt(o.type);
        if (!t) {
            errors.push("out " + (oi + 1) + ": unknown card type " + JSON.stringify(o.type));
            return;
        }
        const family = V4_WT_TO_FAMILY[o.type];
        if (!family) {
            errors.push("out " + (oi + 1) + " (" + t.name + "): no v2 engine family yet — skipped");
            return;
        }
        const famTpls = V4_TPL_TO_FAMILY_TPL[o.type] || t.tpls;
        const deck = (deckRoot || batch.deck || "LinguaStudio") + (o.sub ? "::" + o.sub : "");
        const famFields = V4_FAMILY_FIELDS[family] || [];
        const cards = all.filter((c) => c.oi === oi);
        const notes = cards.map((c) => {
            const fields = v4RowFor(batch, c);
            const skipped = v4Skipped(batch, c);
            const skip = skipped && famTpls[c.ti] ? [famTpls[c.ti]] : [];
            const tags = (c.tags || []).concat((c.w && c.w.tags) || []);
            if (famFields.includes("WriteCfg")) {
                const wc = v4WriteCfg(batch, o, v4ThemeOf(batch, c));
                if (wc) fields.WriteCfg = fields.WriteCfg || wc;
            }
            for (const k of V4_ND_FLAGS) {
                if (famFields.includes(k) && !(k in fields) && batch.flags && batch.flags[k]) fields[k] = "1";
            }
            return { fields, tags: tags.filter(Boolean), skip };
        });
        groups.push({ family, deck, notes });
    });
    return { groups, errors };
}

/* ------------------------------------------------------------------ */
/* v4 presentation — pure data and view-models for the screens.        */
/*                                                                     */
/* The workspace follows the v4 design (Lingua Workspace v4.dc.html):  */
/* a sidebar of batches over the vault's own theme, and a batch        */
/* screen with Words / Card types / Skim. Nothing below touches the    */
/* DOM or the network, so the headless tests cover it directly.        */
/* ------------------------------------------------------------------ */

/* The card themes a learner can pick on the card itself (⚙ → Look), from
   anki/LinguaStudio/styling.css: [id, name, bg, ink, accent, line, light].
   These style the Anki CARDS only — the workspace never sets a theme of its
   own; it renders in the vault's Obsidian theme (CSS variables only). */
const V4_THEMES = [
    ["nocturne", "Nocturne", "#0f1115", "#e6e9ef", "#8fb4ff", "#2a303b", 0],
    ["classic", "Classic", "#0f0f14", "#e2e8f0", "#c084fc", "#2d2d3f", 0],
    ["sumi", "Sumi", "#13110f", "#e8e0d1", "#d8604b", "#3a342d", 0],
    ["washi", "Washi", "#12152a", "#ebe6ee", "#efbac3", "#323857", 0],
    ["konstrukt", "Konstrukt", "#0d0d0d", "#ede7df", "#e8595c", "#363636", 0],
    ["soviet", "Soviet", "#111010", "#ece3cf", "#d0402c", "#3a3230", 0],
    ["futurism", "Futurism", "#101012", "#e9e6e0", "#de4a32", "#34343a", 0],
    ["terminal", "Terminal", "#0c0b0a", "#eadfd1", "#ff7d57", "#3c332b", 0],
    ["lehrbuch", "Lehrbuch", "#1a1810", "#ece5d2", "#e2b85a", "#423d29", 0],
    ["chalk", "Chalk", "#172624", "#e8efe6", "#f1e3a0", "#38524c", 0],
    ["moss", "Moss", "#141915", "#e1e6da", "#b3d1a2", "#313a32", 0],
    ["hojicha", "Hojicha", "#1b1612", "#ecdcc6", "#e4ab70", "#3d332a", 0],
    ["fog", "Fog", "#1e2227", "#d8dde3", "#adc4db", "#3d444c", 0],
    ["paper", "Paper", "#faf7f0", "#2a2520", "#a3421f", "#d6cdb9", 1],
    ["sepia", "Sepia", "#f1e7d0", "#3a3025", "#93441a", "#d2c29d", 1],
    ["lehrbuch-hell", "Lehrbuch hell", "#fbfaf6", "#1a2233", "#1f3a7a", "#c9ced8", 1],
    ["plakat", "Plakat", "#ece3cf", "#141210", "#b8220f", "#141210", 1],
];

function v4Theme(id) {
    return V4_THEMES.find((t) => t[0] === id) || V4_THEMES[2];
}

/* Tone colours (1-4, neutral) for dark and light card themes. */
const V4_TONE_DARK = ["#ff6b6b", "#f5a524", "#4cc38a", "#5aa9ff", "#a9a296"];
const V4_TONE_LIGHT = ["#c62828", "#9a5b00", "#2e7d32", "#1565c0", "#6b6257"];

/* Card Studio catalog — the v2 card families, one style and settings
   system (anki/LinguaStudio_*). `wt` = the word-batch type it can be added
   as (V4_WT id); `builder` = the classic builder that makes it today from
   sentences or hand-written rows (CARD_REGISTRY type). Required fields end
   in `*`; template notes after " · " say when that card is made. */
const V4_CATALOG = [
    ["words", "Vocab", "词", "LinguaStudio", "Mandarin words: meaning, reading, listening, writing and cloze from one note.", ["Meaning", "Reading", "Listening", "Writing · stroke order or freehand", "Cloze fill"], "Simplified*,Pinyin*,Meaning*,Traditional,Zhuyin,Audio,Sentence,SentencePinyin,SentenceTranslation,Image", "Writing and Cloze rate themselves from slips; the rest you rate.", "vocab", ""],
    ["words", "Word", "言", "LinguaStudio_Word", "Every other language in one note type. The Language field sets voice, direction, fonts and reading.", ["Meaning", "Reading · when Reading has a value", "Listening · when Audio has a value", "Writing · stroke order for ja/yue, freehand otherwise"], "Word*,Meaning*,Language*,Reading,Gender,Audio,Sentence,SentenceTranslation", "Listening and Writing rate themselves.", "word", ""],
    ["words", "Tone Drill", "声", "LinguaStudio_Tone_Drill", "Tap each syllable's tone. Tones come from Pinyin, marks or numbers.", ["Tone Read", "Tone Listen · when Audio has a value"], "Simplified*,Pinyin*,Meaning,Traditional,Audio,HSK", "Share of syllables missed sets the grade.", "tone", "tone_drill"],
    ["words", "Visual Cards", "画", "LinguaStudio_Visual_Cards", "Picture to word: pick from four, or write it.", ["Visual Recognition", "Visual Writing"], "Simplified*,Image*,Pinyin,Meaning", "Both rate themselves.", "visual", ""],
    ["words", "Collocations", "搭", "LinguaStudio_Collocations", "The phrases a word lives in: recall them, or fill the word into one.", ["Collocation Recall", "Phrase Completion · write or say"], "Simplified*,Collocations*,Pinyin,Meaning,Audio", "Phrase Completion rates itself when written.", "", "collocation"],
    ["words", "Concept", "知", "LinguaStudio_Concept", "Chengyu, radicals, compounds, mnemonics, definitions, rules, morphemes and writing prompts.", ["Recall", "Reverse · when Reverse has a value"], "Kind*,Front*,Back*,Reading,Literal,Hint,Parts,Details,Example,Image,Audio,Language", "Reverse with Write rates itself; the rest you rate.", "concept", "chengyu"],
    ["sets", "Matching", "配", "LinguaStudio_Matching_Game", "Up to six words on one board, matched to pictures or meanings.", ["Matching", "Write & Match"], "Word1…6*,Right side1…6,Image1…6,Pinyin1…6", "Slips set the grade.", "matching", "matching"],
    ["sets", "Cascade", "瀑", "LinguaStudio_Cascade", "Words flash on the beat, then you recall or write them.", ["Flash", "Write · in-card toggle", "Read"], "Words*,BPM,Pattern", "Write mode rates itself.", "cflash", "cascade"],
    ["sets", "Ladder", "梯", "LinguaStudio_Ladder", "Up to four sentence pairs: read on the metronome, pair by sound, then match and write.", ["Ladder · Full, Short, Pick, Sound or Blind"], "Q1…4*,A1…4*,Reading,Audio,Direction,Stages,Language", "Slips across all stages set the grade.", "", "qa_ladder"],
    ["sets", "Pair Climb", "攀", "LinguaStudio_Pair_Climb", "Study, pick, type and listen across a set of pairs.", ["Pair Climb"], "Pairs*,Language", "Rates itself.", "", ""],
    ["sets", "Dialogue", "话", "LinguaStudio_Dialogue", "A line-by-line player, and your own line to choose, say or write.", ["Dialogue", "Your line · when Target has a line number"], "Lines*,Audio,Target,Choices,Language", "Your line rates itself with Choices.", "", "dialogue"],
    ["sentences", "Sentence", "句", "LinguaStudio_Sentence", "Understand a sentence, or hear it and write it down.", ["Understand", "Dictation · when Audio has a value"], "Sentence*,Reading,Translation,Breakdown,Audio,Language", "Dictation rates itself.", "dictation", "sentence_workshop"],
    ["sentences", "Cloze", "空", "LinguaStudio_Cloze", "Gaps in a sentence: type, pick tiles or write.", ["Cloze"], "Text*,Reading,Translation,Audio,Language", "Rates itself.", "", "custom_cloze"],
    ["sentences", "Scramble", "序", "LinguaStudio_Scramble", "Rebuild the sentence from its meaning, tile by tile.", ["Scramble"], "Sentence*,Translation,Chunks,Reading,Audio,Language", "Slips set the grade.", "", "sentence_scramble"],
    ["sentences", "Translation", "译", "LinguaStudio_Translation", "Translate one way and back; your version shows beside the model.", ["Translate", "Reverse"], "Source*,SourceLang*,Target*,TargetLang*,Romanization,Notes,Audio", "You rate it.", "", "translation"],
    ["sentences", "Choice Quiz", "选", "LinguaStudio_Choice", "Listening MCQ, sound pairs, spot the error, fix it, and grammar patterns.", ["Choice Quiz", "Second word of a pair · when Audio2 has a value", "Fix the error · when Correct has a value"], "Kind*,Options*,Answer*,Sentence,Correct,Audio,Audio2,Explanation", "Rates itself.", "", "error_correction"],
    ["sentences", "Shadowing", "影", "LinguaStudio_Shadowing", "Hear it, say it with the recording, compare.", ["Shadowing"], "Sentence*,Audio*,Reading,Translation", "You rate it.", "", "shadowing"],
    ["planned", "Stack", "叠", "—", "One note, many items. Each review runs a short hand of 6–8 with per-item memory.", ["Stack · planned"], "Items*,Language,Hand size,Activities", "One grade from the weakest items.", "", ""],
].map(([grp, name, glyph, dir, desc, tpls, fields, grade, wt, builder]) =>
    ({ grp, name, glyph, dir, desc, tpls, fields: fields.split(","), grade, wt, builder }));

const V4_CATALOG_GROUPS = [
    ["words", "Words", "Built from a word list"],
    ["sets", "Sets", "Several items on one card"],
    ["sentences", "Sentences", "Built from sentences"],
    ["planned", "Planned", "Waiting on the engine"],
];

/* Language menu: the native name and script group of each registry
   language. Grouped the way the menu shows them. */
const V4_LANG_GROUPS = [
    ["cjk", "Chinese, Japanese & Korean"],
    ["latin", "Latin script"],
    ["cyrl", "Cyrillic & Greek"],
    ["rtl", "Right to left"],
    ["other", "Other scripts"],
];
const V4_LANG_META = {
    zh: ["中文 (简体)", "cjk"], "zh-hans": ["简体中文", "cjk"], "zh-hant": ["中文 (繁體)", "cjk"],
    yue: ["粵語", "cjk"], ja: ["日本語", "cjk"], ko: ["한국어", "cjk"],
    de: ["Deutsch", "latin"], es: ["Español", "latin"], en: ["English", "latin"], fr: ["Français", "latin"],
    pt: ["Português", "latin"], it: ["Italiano", "latin"], nl: ["Nederlands", "latin"], pl: ["Polski", "latin"],
    tr: ["Türkçe", "latin"], vi: ["Tiếng Việt", "latin"], id: ["Bahasa Indonesia", "latin"],
    sw: ["Kiswahili", "latin"], cs: ["Čeština", "latin"], sv: ["Svenska", "latin"], da: ["Dansk", "latin"],
    fi: ["Suomi", "latin"], no: ["Norsk", "latin"], ro: ["Română", "latin"], ca: ["Català", "latin"],
    eu: ["Euskara", "latin"], hu: ["Magyar", "latin"],
    ru: ["Русский", "cyrl"], uk: ["Українська", "cyrl"], el: ["Ελληνικά", "cyrl"],
    ar: ["العربية", "rtl"], fa: ["فارسی", "rtl"], he: ["עברית", "rtl"],
    th: ["ไทย", "other"], hi: ["हिन्दी", "other"], bn: ["বাংলা", "other"],
};

function v4LangNative(vault) {
    const m = V4_LANG_META[vault];
    return m ? m[0] : "";
}

/* Same language, by base subtag — "zh-hans" and "zh" are one language, and
   a language code is never compared with === (see ocrPackFor). */
function sameLang(a, b) {
    return ocrBaseLang(a) === ocrBaseLang(b);
}

/* Language menu groups for a search query: [{key,label,items:[LANGS row]}].
   An empty query keeps every group (each in registry order); a query
   matches the English or the native name and returns one "Results" group. */
function v4LangGroups(query) {
    const q = String(query || "").trim().toLowerCase();
    if (q) {
        const items = LANGS.filter((l) => (l.name + " " + v4LangNative(l.vault) + " " + l.vault)
            .toLowerCase().includes(q));
        return [{ key: "results", label: items.length ? "Results" : "No language matches", items }];
    }
    return V4_LANG_GROUPS.map(([key, label]) => ({
        key, label,
        items: LANGS.filter((l) => (V4_LANG_META[l.vault] || ["", "other"])[1] === key),
    })).filter((g) => g.items.length);
}

/* ---- dictionary answers -> word fields ---- */

/* Senses out of a /translate/word gloss. The CC-CEDICT provider answers
   "[ping2 guo3] apple; … [da2] dozen" — one bracketed reading per
   pronunciation — so only the first reading's senses are kept (they belong
   to the reading the lookup returned). Classifier notes ("CL:個|个[ge4]")
   are dropped and "trad|simp[pin1]" cross-references keep only the word —
   the raw CC-CEDICT syntax never reaches a card. HTML from StarDict entries
   is stripped. Returns {reading, senses}. */
function v4ParseGloss(raw) {
    let s = String(raw || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
    let reading = "";
    const head = s.match(/^\s*\[([^\]]*)\]\s*/);
    if (head) {
        reading = head[1].trim();
        s = s.slice(head[0].length);
        const next = s.search(/\s\[[^\]]*\]\s/);
        if (next >= 0) s = s.slice(0, next);
    }
    const seen = new Set();
    const senses = s.split(/\s*[;\n]\s*/)
        .map((x) => x.replace(/([^\s|[\]]+)\|([^\s|[\]]+)\[[^\]]*\]/g, "$2")
            .replace(/([^\s[\]]+)\[[a-zA-Z:]+[1-5](?: [a-zA-Z:]+[1-5])*\]/g, "$1")
            .replace(/\s+/g, " ").trim())
        .filter((x) => x && !/^CL:/i.test(x))
        .map((x) => (x.length > 120 ? x.slice(0, 119).trimEnd() + "…" : x))
        .filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, 12);
    return { reading, senses };
}

/* One meaning, or several senses to pick from. A short run of close senses
   ("flavor; smell; taste") reads as one meaning; a long or many-sense
   entry (打: to hit; to play; to make a call; …) is offered as a picker —
   the "Several senses" flag and the keep-the-first-sense rule act on it. */
function v4MeaningFromSenses(senses) {
    const list = (senses || []).filter(Boolean);
    if (list.length <= 1) return { M: list[0] || "", senses: [] };
    const joined = list.join("; ");
    if (list.length <= 3 && joined.length <= 40) return { M: joined, senses: [] };
    return { M: "", senses: list };
}

/* Tone-numbered pinyin ("ping2 guo3", CC-CEDICT) -> tone marks ("píng
   guǒ"). Syllables without a trailing tone digit pass through untouched,
   so already-marked pinyin is safe to feed in. */
const V4_MARKS = { a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù", "ü": "ǖǘǚǜ" };
function v4PinyinMarks(text) {
    return String(text || "").split(/(\s+)/).map((syl) => {
        const m = syl.match(/^([A-Za-zü:]+)([1-5])$/);
        if (!m) return syl;
        const base = m[1].replace(/u:|v/g, "ü").replace(/U:|V/g, "Ü");
        const tone = +m[2];
        if (tone === 5) return base;
        const lower = base.toLowerCase();
        let idx = lower.indexOf("a");
        if (idx < 0) idx = lower.indexOf("e");
        if (idx < 0 && lower.includes("ou")) idx = lower.indexOf("o");
        if (idx < 0) {
            for (let i = lower.length - 1; i >= 0; i--) {
                if ("aeiouü".includes(lower[i])) { idx = i; break; }
            }
        }
        if (idx < 0) return base;
        let mark = V4_MARKS[lower[idx]][tone - 1];
        if (base[idx] !== lower[idx]) mark = mark.toUpperCase();
        return base.slice(0, idx) + mark + base.slice(idx + 1);
    }).join("");
}

/* One pinyin syllable -> {base (lowercase, no marks), tone 1-5}. Accepts
   marks or a trailing digit. */
const V4_MARK_INDEX = (() => {
    const out = {};
    for (const [base, marks] of Object.entries(V4_MARKS)) {
        [...marks].forEach((ch, i) => { out[ch] = { base, tone: i + 1 }; });
    }
    return out;
})();
function v4SyllableTone(syl) {
    const s = String(syl || "").toLowerCase().replace(/u:|v/g, "ü");
    const d = s.match(/^(.*?)([1-5])$/);
    if (d) return { base: d[1], tone: +d[2] };
    let tone = 5, base = "";
    for (const ch of s) {
        const t = V4_MARK_INDEX[ch];
        if (t) { tone = t.tone; base += t.base; } else base += ch;
    }
    return { base, tone };
}

/* Pinyin -> Zhuyin (bopomofo), syllable by syllable, for the Vocab card's
   Zhuyin field. Tones: 2 ˊ, 3 ˇ, 4 ˋ, neutral ˙ in front. Returns "" when
   any syllable is not a pinyin syllable — a partial conversion would put
   wrong text on a card. */
const V4_ZY_INIT = { b: "ㄅ", p: "ㄆ", m: "ㄇ", f: "ㄈ", d: "ㄉ", t: "ㄊ", n: "ㄋ", l: "ㄌ", g: "ㄍ", k: "ㄎ", h: "ㄏ", j: "ㄐ", q: "ㄑ", x: "ㄒ", zh: "ㄓ", ch: "ㄔ", sh: "ㄕ", r: "ㄖ", z: "ㄗ", c: "ㄘ", s: "ㄙ" };
const V4_ZY_FIN = { a: "ㄚ", o: "ㄛ", e: "ㄜ", "ê": "ㄝ", ai: "ㄞ", ei: "ㄟ", ao: "ㄠ", ou: "ㄡ", an: "ㄢ", en: "ㄣ", ang: "ㄤ", eng: "ㄥ", er: "ㄦ", ong: "ㄨㄥ",
    i: "ㄧ", ia: "ㄧㄚ", ie: "ㄧㄝ", iao: "ㄧㄠ", iu: "ㄧㄡ", ian: "ㄧㄢ", in: "ㄧㄣ", iang: "ㄧㄤ", ing: "ㄧㄥ", iong: "ㄩㄥ",
    u: "ㄨ", ua: "ㄨㄚ", uo: "ㄨㄛ", uai: "ㄨㄞ", ui: "ㄨㄟ", uan: "ㄨㄢ", un: "ㄨㄣ", uang: "ㄨㄤ",
    "ü": "ㄩ", "üe": "ㄩㄝ", "üan": "ㄩㄢ", "ün": "ㄩㄣ" };
const V4_ZY_WHOLE = { yi: "ㄧ", ya: "ㄧㄚ", yo: "ㄧㄛ", ye: "ㄧㄝ", yao: "ㄧㄠ", you: "ㄧㄡ", yan: "ㄧㄢ", yin: "ㄧㄣ", yang: "ㄧㄤ", ying: "ㄧㄥ", yong: "ㄩㄥ",
    yu: "ㄩ", yue: "ㄩㄝ", yuan: "ㄩㄢ", yun: "ㄩㄣ",
    wu: "ㄨ", wa: "ㄨㄚ", wo: "ㄨㄛ", wai: "ㄨㄞ", wei: "ㄨㄟ", wan: "ㄨㄢ", wen: "ㄨㄣ", wang: "ㄨㄤ", weng: "ㄨㄥ" };
const V4_ZY_TONE = ["", "ˊ", "ˇ", "ˋ"];
function v4ZhuyinSyllable(base) {
    if (V4_ZY_WHOLE[base]) return V4_ZY_WHOLE[base];
    const im = base.match(/^(zh|ch|sh|[bpmfdtnlgkhjqxrzcs])(.*)$/);
    if (!im) return V4_ZY_FIN[base] || null;
    const ini = im[1];
    let fin = im[2];
    if (!fin) return null;
    if (fin === "i" && ["zh", "ch", "sh", "r", "z", "c", "s"].includes(ini)) return V4_ZY_INIT[ini];
    if ("jqx".includes(ini) && fin.startsWith("u")) fin = "ü" + fin.slice(1);
    return V4_ZY_FIN[fin] ? V4_ZY_INIT[ini] + V4_ZY_FIN[fin] : null;
}
function v4Zhuyin(pinyin) {
    const out = [];
    for (const syl of String(pinyin || "").trim().split(/\s+/).filter(Boolean)) {
        const { base, tone } = v4SyllableTone(syl.replace(/[^\p{L}1-5:]/gu, ""));
        let z = v4ZhuyinSyllable(base), er = "";
        // Erhua written into the syllable (diǎnr): the toned syllable, then ㄦ.
        if (!z && base.length > 1 && base.endsWith("r")) {
            z = v4ZhuyinSyllable(base.slice(0, -1));
            er = "ㄦ";
        }
        if (!z) return "";
        out.push((tone === 5 ? "˙" + z : z + V4_ZY_TONE[tone - 1]) + er);
    }
    return out.join(" ");
}

/* A /translate/word answer -> the word patch it implies, for a word in
   `vault` language. Never overwrites what the operator already typed
   (P/M/senses stay when set). Mandarin readings come tone-numbered from
   CC-CEDICT and are turned into marks; Zhuyin is derived from them. */
function v4LookupPatch(w, r, vault) {
    if (!r || !r.provider) return {};
    const parsed = v4ParseGloss(r.gloss);
    const patch = {};
    const mandarin = isMandarinLang(vault);
    let reading = String(r.reading || parsed.reading || "").trim();
    if (mandarin) reading = v4PinyinMarks(reading);
    if (!w.P && reading) patch.P = reading;
    if (!w.M && !(w.senses || []).length) {
        const m = v4MeaningFromSenses(parsed.senses);
        if (m.M) patch.M = m.M;
        if (m.senses.length) patch.senses = m.senses;
    }
    if (mandarin && !w.Z) {
        const z = v4Zhuyin(patch.P || w.P);
        if (z) patch.Z = z;
    }
    return patch;
}

/* ---- card preview view-model (Skim) ---- */

/* What a card looks like, in the abstract: the hero, prompt, back blocks
   and colours for one card of `typeId` from its engine row (v4RowFor) on
   template `ti`, `side` front|back, in card theme `themeId`. The DOM layer
   draws it at any size; this decides only what appears. */
function v4CardView(typeId, row, ti, side, themeId) {
    const th = v4Theme(themeId);
    const tc = th[6] ? V4_TONE_LIGHT : V4_TONE_DARK;
    const type = v4Wt(typeId) || V4_WT[0];
    row = row || {};
    const v = { bg: th[2], ink: th[3], ac: th[4], line: th[5], mu: th[6] ? "#5b5247" : "#aaa296",
        tag: type.tpls[ti] || type.tpls[0], pos: (ti + 1) + "/" + type.tpls.length,
        front: side !== "back", back: side === "back",
        heroBig: "", heroSize: "5.2em", heroText: "", sub: "", prompt: "", writeBox: false,
        chars: [], syl: [], title: "", blocks: [] };
    const len = (s) => [...String(s || "")].length;
    const big = (s) => (len(s) === 1 ? "5.6em" : len(s) === 2 ? "4em" : len(s) === 3 ? "2.9em" : "2.2em");
    const cjk = (s) => /[㐀-鿿぀-ヿ가-힯]/.test(String(s || ""));
    const sylOf = (p) => String(p || "").split(/\s+/).filter(Boolean)
        .map((s) => ({ t: s, c: tc[v4ToneOf(s) - 1] }));
    const charsOf = (word, syl) => {
        const cs = [...String(word || "")];
        const ok = syl.length === cs.length;
        return cs.map((c, i) => ({ t: c, c: ok ? syl[i].c : "transparent" }));
    };
    const hero = (word) => {
        if (len(word) && len(word) <= 4 && cjk(word)) { v.heroBig = word; v.heroSize = big(word); }
        else v.heroText = word || "—";
    };
    const backHead = (word, reading) => {
        const syl = cjk(word) ? sylOf(reading) : [];
        if (len(word) && len(word) <= 4 && cjk(word)) {
            v.chars = charsOf(word, syl);
            v.heroSize = len(word) === 1 ? "4.6em" : len(word) === 2 ? "3.6em" : "2.6em";
        } else v.title = word || "—";
        if (syl.length) v.syl = syl;
        else if (reading) v.sub = reading;
    };
    const block = (l, t, size, t2, t3) => { if (t) v.blocks.push({ l, t, size: size || "1.2em", t2: t2 || "", t3: t3 || "" }); };

    if (typeId === "vocab") {
        const S = row.Simplified || "";
        const tpl = v.tag;
        if (v.front) {
            if (tpl === "Meaning" || tpl === "Reading") {
                hero(S);
                v.prompt = tpl === "Meaning" ? "What does it mean?" : "Say it, then flip";
            } else if (tpl === "Listening") { v.heroBig = "▶"; v.heroSize = "3em"; v.prompt = "Type what you hear"; }
            else if (tpl === "Writing") { v.heroText = row.Meaning || "—"; v.sub = row.Pinyin || ""; v.writeBox = true; v.prompt = "Write the characters"; }
            else {
                v.heroText = row.Sentence ? row.Sentence.split(S).join("＿＿") : "(no example)";
                v.sub = row.SentenceTranslation || "";
                v.prompt = "Fill the gap";
            }
        } else {
            backHead(S, row.Pinyin);
            const extra = [row.Traditional && row.Traditional !== S ? row.Traditional : "", row.Zhuyin].filter(Boolean).join(" · ");
            if (extra) v.sub = v.sub ? v.sub + " · " + extra : extra;
            block("Meaning", row.Meaning || "—", "1.6em");
            block("Example", row.Sentence, "1.25em", row.SentencePinyin, row.SentenceTranslation);
        }
        return v;
    }
    if (typeId === "matching") {
        const pairs = [];
        for (let i = 1; i <= 6; i++) if (row["Word" + i]) pairs.push([row["Word" + i], row["Meaning" + i] || "?"]);
        if (v.front) {
            v.heroText = pairs.map((p) => p[0]).join(" · ") || "—";
            v.prompt = v.tag === "Match" ? "Match each word" : "Match, then write each word";
        } else {
            v.title = "Answers";
            pairs.forEach((p) => block(p[0], p[1], "1.1em"));
        }
        return v;
    }
    if (typeId === "cflash") {
        const words = String(row.Text || "").split(/\s+/).filter(Boolean);
        if (v.front) {
            v.heroText = words.slice(0, 8).join("  ") || "—";
            v.sub = (row.Rate || "80") + " BPM · " + (row.Pattern || "cross");
            v.prompt = "Words flash on the beat";
        } else {
            v.title = row.Title || "Cascade";
            block("Words", words.join(" "), "1.3em");
        }
        return v;
    }
    const word = row.Simplified || row.Word || row.Front || row.Item || row.Sentence || "";
    const reading = row.Pinyin || row.Reading || "";
    const meaning = row.Meaning || row.Back || "";
    if (v.front) {
        if (typeId === "tone") { hero(word); v.sub = String(reading).replace(/[^\s]/g, (c) => (V4_MARK_INDEX[c] ? V4_MARK_INDEX[c].base : c)); v.prompt = v.tag === "Tone Listen" ? "Listen, then tap the tones" : "Tap the tone of each syllable"; }
        else if (typeId === "hanzi") { v.heroText = meaning || "—"; v.sub = reading; v.writeBox = true; v.prompt = "Write it stroke by stroke"; }
        else if (typeId === "dictation") { v.heroBig = "▶"; v.heroSize = "3em"; v.prompt = "Type what you hear"; }
        else if (typeId === "timed") { hero(word); v.prompt = "Hold it in mind…"; }
        else if (typeId === "visual") { v.heroText = row.Image ? "🖼" : "(no image)"; v.prompt = v.tag === "Writing" ? "Write the word" : "Which word is this?"; }
        else if (typeId === "concept" && v.tag === "Reverse") { v.heroText = meaning || "—"; v.prompt = "Recall the word"; }
        else if (typeId === "word" && v.tag === "Listening") { v.heroBig = "▶"; v.heroSize = "3em"; v.prompt = "Type what you hear"; }
        else if (typeId === "word" && v.tag === "Writing") { v.heroText = meaning || "—"; v.writeBox = true; v.prompt = "Write the word"; }
        else { hero(word); v.prompt = typeId === "concept" ? "Recall the meaning" : "What does it mean?"; }
    } else {
        backHead(word, reading);
        block("Meaning", meaning, "1.5em");
        block("Example", row.Sentence !== word ? row.Sentence : "", "1.2em", "", row.SentenceTranslation);
    }
    return v;
}

/* ---- batch summaries ---- */

/* Counts the header, sidebar and tabs show for a batch, computed once:
   words, card types, live (exported) cards, skipped, changed (cards with a
   per-card override), and how many words still need a look. */
function v4Summary(batch) {
    const cards = v4Cards(batch);
    const live = cards.filter((c) => !v4Skipped(batch, c)).length;
    const changed = cards.filter((c) => { const o = (batch.ov || {})[c.key]; return o && Object.keys(o).length; }).length;
    const flags = (batch.words || []).map((w) => v4FlagsOf(Object.assign({}, w, { M: v4EffMeaning(w, batch) })));
    return { words: (batch.words || []).length, types: (batch.outs || []).length, cards: cards.length,
        live, skipped: cards.length - live, changed, needN: flags.filter((f) => f.length).length, flags };
}

/* Engine row keys a Skim edit may override, per card type (audio, images
   and derived readings are not hand-edited per card). */
const V4_EDITABLE = {
    vocab: ["Simplified", "Pinyin", "Meaning", "Sentence", "SentenceTranslation"],
    tone: ["Simplified", "Pinyin", "Meaning"],
    hanzi: ["Simplified", "Pinyin", "Meaning"],
    dictation: ["Sentence"],
    concept: ["Front", "Back", "Reading"],
    word: ["Word", "Reading", "Meaning", "Sentence", "SentenceTranslation"],
    visual: ["Simplified", "Pinyin", "Meaning"],
    timed: ["Item"],
};

/* Engine row keys a card needs to be made, per card type — the Card types
   tab warns, per type, how many words are missing one. */
const V4_REQUIRED = {
    vocab: ["Simplified", "Pinyin", "Meaning"],
    tone: ["Simplified", "Pinyin"],
    hanzi: ["Simplified", "Pinyin", "Meaning"],
    dictation: ["Sentence", "Audio"],
    concept: ["Front", "Back"],
    word: ["Word", "Meaning"],
    visual: ["Simplified", "Image", "Meaning"],
    timed: ["Item"],
};
const V4_FIELD_LABEL = { Simplified: "Word", Front: "Word", Back: "Meaning", Item: "Word" };

/* Per out: how many words lack a required field, and which fields. */
function v4MissingFor(batch, oi) {
    const o = (batch.outs || [])[oi];
    const t = o && v4Wt(o.type);
    if (!t || t.group) return { count: 0, fields: [] };
    const req = V4_REQUIRED[o.type] || [];
    const fields = new Set();
    let count = 0;
    for (const w of batch.words || []) {
        const row = v4RowFor(batch, { t, o, w, key: "" });
        const miss = req.filter((k) => !String(row[k] || "").trim());
        if (miss.length) { count++; miss.forEach((k) => fields.add(V4_FIELD_LABEL[k] || k)); }
    }
    return { count, fields: [...fields] };
}

/* ---- export without a family exporter ---- */

/* The LinguaStudio engine builds the v2 families through one route when it
   has them (FAMILY_ROUTES, v4BatchToFamilyGroups); until then a batch is
   exported through the classic routes the engine has always had. This is
   that translation, out by out:
     vocab / word / visual -> /vocab/push|export, words grouped by the set
       of templates they keep (a skipped template is left out of the note),
       a card with its own field edits becomes its own single-template note;
     tone / hanzi / matching / dictation / timed / concept -> the classic
       builder for that card (/push|export/<type>) with its row shape;
     cflash -> the cascade builder, with the definitions it never got
       (definitions_json) so the Def panel and the back list are filled.
   `only` (optional) limits it to those out indexes — the outs the family
   route could not take. Pure: returns {jobs, notes}. A job is {kind: "vocab"|"builder", type,
   label, deck, cards, payload}; notes are what the classic routes cannot
   carry, said once instead of silently dropped. */
const V4_CLASSIC_BUILDER = { tone: "tone_drill", hanzi: "hanzi_writer", matching: "matching",
    dictation: "dictation", timed: "timed_recall", concept: "definition_drill", cflash: "cascade" };

function v4ToneNumbers(pinyin) {
    return String(pinyin || "").split(/\s+/).filter(Boolean).map((s) => String(v4ToneOf(s))).join("-");
}

function v4ExportJobs(batch, deckRoot, only) {
    const jobs = [], notes = [];
    const lang = langByVault(batch.lang || "zh");
    const all = v4Cards(batch);
    const audioFile = (w) => w.audioFile || "";
    (batch.outs || []).forEach((o, oi) => {
        if (only && !only.includes(oi)) return;
        const t = v4Wt(o.type);
        if (!t) { notes.push("Unknown card type " + JSON.stringify(o.type) + " was left out."); return; }
        const deck = (deckRoot || batch.deck || "LinguaStudio") + (o.sub ? "::" + o.sub : "");
        const cards = all.filter((c) => c.oi === oi && !v4Skipped(batch, c));
        if (!cards.length) return;
        const label = t.name;

        if (o.type === "vocab" || o.type === "word" || o.type === "visual") {
            // word id -> [{payloadKey, payload, tpl}]
            const groups = new Map();
            for (const c of cards) {
                const row = v4RowFor(batch, c);
                const w = c.w;
                const payload = o.type === "word"
                    ? { word: row.Word, trans: row.Reading, meaning: row.Meaning, audio: audioFile(w),
                        traditional: "", zhuyin: "", image: w.image || "",
                        sentence: row.Sentence || "", sentenceTranslation: row.SentenceTranslation || "" }
                    : { word: row.Simplified, trans: row.Pinyin, meaning: row.Meaning, audio: audioFile(w),
                        traditional: row.Traditional || "", zhuyin: row.Zhuyin || "", image: row.Image || w.image || "",
                        sentence: row.Sentence || "", sentencePinyin: row.SentencePinyin || "",
                        sentenceTranslation: row.SentenceTranslation || "" };
                const own = ((batch.ov || {})[c.key] || {}).f;
                const key = own && Object.keys(own).length ? c.key : JSON.stringify(payload);
                const tpl = o.type === "visual" ? "Visual" : t.tpls[c.ti];
                if (!groups.has(key)) groups.set(key, { payload, tpls: [] });
                groups.get(key).tpls.push(tpl);
            }
            // template set -> words
            const bySet = new Map();
            for (const g of groups.values()) {
                const tpls = [...new Set(g.tpls)];
                const k = tpls.join("|");
                if (!bySet.has(k)) bySet.set(k, { tpls, words: [] });
                bySet.get(k).words.push(g.payload);
            }
            for (const { tpls, words } of bySet.values()) {
                const selected = o.type === "vocab" ? vocabTemplateList(tpls) : tpls;
                jobs.push({ kind: "vocab", type: o.type, label: label + (bySet.size > 1 ? " · " + tpls.join(", ") : ""),
                    deck, cards: words.length * tpls.length,
                    payload: { words, lang: lang.lingua, deckName: deck, selectedTemplates: selected } });
            }
            return;
        }

        const type = V4_CLASSIC_BUILDER[o.type];
        if (!type) { notes.push(label + " has no builder to export with yet."); return; }
        if (t.group) {
            const groupCards = new Map();
            for (const c of cards) groupCards.set(c.key.split(":").slice(0, 2).join(":"), c);
            const rows = [];
            for (const c of groupCards.values()) {
                if (o.type === "matching") {
                    c.ws.forEach((w) => rows.push({ left: w.S, right: v4EffMeaning(w, batch) || "" }));
                } else {
                    const defs = {};
                    c.ws.forEach((w) => { defs[w.S] = { py: w.P || "", m: v4EffMeaning(w, batch) || "" }; });
                    const row = v4RowFor(batch, c);
                    const job = cascadeJobs([{ mode: "cascade", title: row.Title + " " + (rows.length + 1),
                        text: row.Text, bpm: parseInt(row.Rate, 10) || 80, pattern: row.Pattern || "cross",
                        meter: "4/4", dispMode: "auto", ttsBeats: [1], gapCycles: 1, subdiv: 1,
                        randomize: false, writingOn: false }], lang.lingua)[0][1][0];
                    job.definitions_json = JSON.stringify(defs);
                    rows.push(job);
                }
            }
            if (o.tpls.length < t.tpls.length) notes.push(label + ": the classic builder makes every template — the ones turned off are made too.");
            jobs.push({ kind: "builder", type, label, deck, cards: cards.length,
                payload: { batch: rows, deck_name: deck, lang: lang.lingua } });
            return;
        }
        const byWord = new Map();
        for (const c of cards) if (!byWord.has(c.w.id)) byWord.set(c.w.id, c);
        if (o.tpls.length < t.tpls.length) {
            notes.push(label + ": the classic builder makes every template — the ones turned off are made too.");
        } else if ([...byWord.keys()].some((id) => cards.filter((c) => c.w.id === id).length < o.tpls.length)) {
            notes.push(label + ": the classic builder makes every template of a note — a single skipped template is made anyway.");
        }
        const rows = [...byWord.values()].map((c) => {
            const row = v4RowFor(batch, c);
            const w = c.w;
            switch (o.type) {
                case "tone": return { word: row.Simplified, syllable: row.Pinyin, tones: v4ToneNumbers(row.Pinyin), audio: audioFile(w), meaning: row.Meaning || "" };
                case "hanzi": return { hanzi: row.Simplified, pinyin: row.Pinyin, meaning: row.Meaning || "", radical: "" };
                case "dictation": return { transcript: row.Sentence, audio: audioFile(w), speed: "1" };
                case "timed": return { word: row.Item, meaning: v4EffMeaning(w, batch) || "", prompt: "", image: w.image || "", audio: audioFile(w), exposure: row["Exposure s"] || "5", delay: row["Delay s"] || "20", alarm: "true", tags: "" };
                default: return { word: row.Front, description: row.Back || "", distractors: "" };
            }
        });
        jobs.push({ kind: "builder", type, label, deck, cards: cards.length,
            payload: { batch: rows, deck_name: deck, lang: lang.lingua } });
    });
    const themed = (batch.outs || []).some((o) => o.themes) || (batch.themes || []).length > 1
        || Object.keys(batch.flags || {}).some((k) => batch.flags[k]);
    if (themed) notes.push("Theme choices and accessibility defaults ride on the card families; the classic routes don't carry them yet.");
    return { jobs, notes };
}

/* ---- stacks ---- */

/* A stack: batches in study order, each filed as a numbered subdeck under
   one root. Returns the deck tree the Stack screen shows and the export
   uses: [{n, batch, deck, cards}] for the batches that still exist. */
function v4StackSteps(stack, batches, prefix) {
    const root = (prefix || "LinguaStudio") + "::" + String((stack && stack.name) || "Stack").replace(/::/g, " ");
    const steps = [];
    for (const id of (stack && stack.steps) || []) {
        const b = (batches || []).find((x) => x.id === id);
        if (!b) continue;
        const n = steps.length + 1;
        steps.push({ n, batch: b, deck: root + "::" + String(n).padStart(2, "0") + " " + b.name.replace(/::/g, " "),
            cards: v4Summary(b).live });
    }
    return { root, steps };
}

/* ---- routing ---- */

/* Main-view screens. Old saved view states and links name the sections of
   the 15-tab layout; every one of them still lands somewhere. */
const V4_SCREENS = ["batch", "inbox", "review", "studio", "stats", "manage", "stack",
    "dictionary", "sentences", "builders", "tools"];
const V4_SECTION_ROUTES = {
    capture: { screen: "inbox" }, anki: { screen: "inbox" }, vocab: { screen: "batch" },
    cloze: { screen: "sentences" }, tts: { screen: "manage", sub: "voices" },
    manage: { screen: "manage", sub: "languages" }, settings: { screen: "manage", sub: "settings" },
};
function v4RouteFor(name) {
    if (V4_SECTION_ROUTES[name]) return Object.assign({}, V4_SECTION_ROUTES[name]);
    if (V4_SCREENS.includes(name)) return { screen: name };
    return { screen: "batch" };
}

/* "2 hours ago" for an Inbox entry's capture time (ms). */
function v4Ago(ts, now) {
    if (!ts) return "";
    const s = Math.max(0, Math.round(((now || Date.now()) - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
    const h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    const d = Math.round(h / 24);
    if (d === 1) return "yesterday";
    return d + " days ago";
}

/* Words out of pasted text: one per line, or separated by spaces, commas or
   the CJK enumeration comma. Order kept, duplicates dropped. */
function v4SplitWords(text) {
    const seen = new Set();
    return String(text || "").split(/[\s,，、;；]+/).map((x) => x.trim())
        .filter((x) => x && !seen.has(x) && seen.add(x));
}

// ----- Whisper (speech-to-text) helpers -----
// Phase 1 only: transcribe a picked file. Live mic capture and
// target-sentence scoring are a distinct, larger phase 2 (see the paired
// sidecar commit's app/whisper_engine.py docstring) — not built here.

// A CPU-only local model runs roughly real-time (see the sidecar commit's
// live numbers) — a long clip means a long wait with no progress feedback,
// since requestUrl has none. This is a soft ceiling past which the UI asks
// for a shorter clip instead of kicking off a request that just looks hung.
const MAX_WHISPER_AUDIO_BYTES = 20 * 1024 * 1024;

function whisperTooLarge(byteLength) {
    return byteLength > MAX_WHISPER_AUDIO_BYTES;
}

// File.type is often empty (drag-drop, some mobile pickers) — fall back to
// the extension so the sidecar's mime->temp-file-suffix mapping
// (routers/whisper.py's _suffix_for) still gets a usable hint instead of
// silently landing on its ".audio" catch-all.
const WHISPER_EXT_MIME = {
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
    ogg: "audio/ogg", oga: "audio/ogg", webm: "audio/webm", flac: "audio/flac",
};

function whisperMime(file) {
    if (file && file.type) return file.type;
    const name = (file && file.name) || "";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    return WHISPER_EXT_MIME[ext] || "";
}

// bytes -> base64, chunked through String.fromCharCode.apply rather than
// the OCR tool's byte-at-a-time `+=` loop (fine for an image, visibly janky
// on a multi-MB audio file) or a single `String.fromCharCode(...bytes)`
// spread (throws "Maximum call stack size exceeded" past V8's argument-count
// ceiling, tens of thousands of bytes — reachable well before
// MAX_WHISPER_AUDIO_BYTES). 0x8000 stays safely under that ceiling.
function bytesToBase64(bytes) {
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

function whisperText(response) {
    if (!response || response.ok === false) return "";
    return String(response.text || "").trim();
}

// TTS voice shapes vary by engine — the app keys on a display-name `id`
// (never edge-tts's raw ShortName). Accept whatever the endpoint returns.
function ttsVoiceId(v) {
    if (typeof v === "string") return v;
    return String(v.id || v.name || v.short_name || v.ShortName || "");
}

function ttsVoiceLabel(v) {
    if (typeof v === "string") return v;
    const name = v.label || v.name || v.id || ttsVoiceId(v);
    const gender = v.gender ? ` · ${v.gender}` : "";
    const locale = v.locale ? ` (${v.locale})` : "";
    return `${name}${locale}${gender}`;
}

/* The base64 mp3 out of an audio response, whatever the endpoint called it.
   LinguaStudio is not consistent: /vocab/audio and /vocab/audio/select answer
   `audioB64`, while /tts/preview answers `audio`. This port read `audioB64`
   everywhere, so Preview — the one button whose whole job is to play a voice —
   could never find its audio and always reported "Voice ok, but no audio came
   back", which reads as an engine fault rather than a field name.
   Read both, in the manner of ttsVoiceId above. */
function ttsAudioB64(r) {
    if (!r || typeof r !== "object") return "";
    return String(r.audioB64 || r.audio || "");
}

// Sentence-lookup rows: {text, translation?} | {sentence, gloss?} | string.
function sentenceText(s) {
    if (typeof s === "string") return s;
    return String(s.text || s.sentence || s.zh || s.original || "");
}

function sentenceGloss(s) {
    if (typeof s === "string") return "";
    return String(s.translation || s.gloss || s.en || s.meaning || "");
}

// A dictionary / sentence pack entry -> {label, installed, busy}.
// Field names differ between the two endpoints; sniff the common shapes.
function packStatus(pk) {
    if (typeof pk.progress === "number" && pk.progress > 0 && pk.progress < 100) {
        return { label: `downloading ${Math.round(pk.progress)}%`, busy: true,
            installed: false };
    }
    const raw = String(pk.status || "").toLowerCase();
    if (raw && raw !== "installed" && raw !== "downloaded" && raw !== "available"
            && raw !== "not_installed") {
        return { label: pk.status, busy: raw.includes("download")
            || raw.includes("import") || raw.includes("progress"), installed: false };
    }
    const installed = pk.installed === true || pk.downloaded === true
        || raw === "installed" || raw === "downloaded";
    return { label: installed ? "installed" : "available", busy: false, installed };
}

function uid() {
    return Math.random().toString(36).slice(2, 10);
}

/* ------------------------------------------------------------------ */
/* backend client                                                      */
/* ------------------------------------------------------------------ */

// Keyed by the `kind` passed to call() below. Each hint is a function of the
// URL actually configured, not a static sentence — "isn't running" alone
// told an operator who'd changed linguaSidecarUrl away from the default
// nothing about *which* address just failed to connect. Anki export/push
// funnels through here too (kind "lingua"), so a downed LinguaStudio engine
// surfaces the same actionable message there as everywhere else.
const SERVER_HINTS = {
    vault: (url) => `vault sidecar isn't running at ${url} — start it `
        + "(cd sidecar && .venv/bin/uvicorn app.main:app --port 8749), or check "
        + "the URL in Lingua settings.",
    lingua: (url) => `LinguaStudio engine isn't reachable at ${url} — start it `
        + "(it auto-starts with this workspace when auto-start is on, or "
        + "`npm run sidecar` in lingua-studio), or check the URL in Lingua settings.",
    anki: (url) => `AnkiConnect isn't reachable at ${url} — is Anki open with `
        + "the AnkiConnect add-on?",
};

function serverDownMessage(kind, base) {
    const hint = SERVER_HINTS[kind];
    return hint ? hint(base) : `no response from ${base}`;
}

// Which sidecar answers /vocab/export. The paired sidecar commit adds
// POST /vocab/export to the vault sidecar, answering the identical
// {words[], lang, deckName, selectedTemplates[], filename} -> {ok, path}
// shape LinguaStudio's own /vocab/export always has, so the vault sidecar
// now builds the .apkg itself for the vocab round trip — LinguaStudio still
// builds every other card type's .apkg (/export/{type}, /cardstudio/export,
// /export/stack) and still owns /vocab/push (the AnkiConnect live-push; see
// routers/anki.py's module docstring for why that one stays deliberately
// out of scope). /vocab/lookup has since ported too — see /translate/word.
// Both vocab-export call sites route through here instead of hand-copying it,
// so "which sidecar" is decided once and can't quietly drift apart again.
function vocabExportSidecar(settings) {
    return { kind: "vault", base: settings.vaultSidecarUrl };
}

async function call(kind, base, path, body) {
    let res;
    try {
        res = await obsidian.requestUrl({
            url: String(base).replace(/\/$/, "") + path,
            method: body === undefined ? "GET" : "POST",
            contentType: "application/json",
            body: body === undefined ? undefined : JSON.stringify(body),
            throw: false,
        });
    } catch (e) {
        throw new Error(serverDownMessage(kind, base));
    }
    if (!res || res.status <= 0) throw new Error(serverDownMessage(kind, base));
    let json = null;
    try { json = res.json; } catch (e) { /* non-JSON body */ }
    if (res.status >= 400) {
        const detail = json && (json.detail || json.error);
        throw new Error(detail ? String(detail) : `HTTP ${res.status} from ${path}`);
    }
    return json;
}

/* ------------------------------------------------------------------ */
/* the main workbench view                                             */
/* ------------------------------------------------------------------ */

// 6.1's route audit found lingua-workspace covers mine (capture), author
// (vocab/builders/studio/cloze) and dictionary already, but had no doorway to
// REVIEW or STATS at all — the operator had to leave entirely for
// reading-companion's Study command or flashcards-workspace's button to
// review, and there was no at-a-glance summary of the vocabulary CSV inside
// the workspace meant to be its single home. Both sections below close that,
// reusing what already exists rather than rebuilding it: "review" opens
// reading-companion's real Study surface (the exact call flashcards-
// workspace already makes — see its own README on why nothing here may ever
// re-implement scheduling), and "stats" reads the same CSV the DataviewJS
// Vocabulary note reads, as a native quick-glance rather than a second
// renderer for the same data.
const SECTIONS = ["capture", "vocab", "review", "dictionary", "sentences", "cloze",
    "builders", "studio", "stack", "tts", "tools", "manage", "stats", "settings", "anki"];
const SECTION_LABELS = {
    capture: "Capture", vocab: "Vocab", review: "Review", dictionary: "Dictionary",
    sentences: "Sentences", cloze: "Cloze", builders: "Builders",
    studio: "Card Studio", stack: "Stack Studio", tts: "TTS", tools: "Tools", manage: "Manage",
    stats: "Stats", settings: "Settings", anki: "Anki",
};

/* ------------------------------------------------------------------ */
/* Cascade — the app's two-mode builder, not a flat form.              */
/* ------------------------------------------------------------------ */
const CASCADE_PATTERNS = [
    { value: "cross", label: "✚ Cross (4-beat)" },
    { value: "corners", label: "⬛ Corners (4-beat)" },
    { value: "lineH", label: "↔ Line H (3-beat)" },
    { value: "lineV", label: "↕ Line V (3-beat)" },
    { value: "circle4", label: "○ Circle 4 (4-beat)" },
    { value: "spotlight", label: "◎ Spotlight (center)" },
];
const CASCADE_METERS = [
    { value: "2/4", count: 2 }, { value: "3/4", count: 3 },
    { value: "4/4", count: 4 }, { value: "6/8", count: 6 },
];
const CASCADE_DISPLAY = [
    { value: "auto", label: "Auto (by word count)" },
    { value: "drill", label: "Drill — loop one word" },
    { value: "multiword", label: "Word flash" },
    { value: "sentence", label: "Sentence flow" },
];

function cascadeMeterCount(meter) {
    const m = CASCADE_METERS.find((x) => x.value === meter);
    return m ? m.count : 4;
}

// Serialize the metronome config into the BeatConfig JSON the card template
// consumes — the exact shape CascadeComposite.jsx emits.
function cascadeBeatConfig(cfg, lang) {
    const count = cascadeMeterCount(cfg.meter);
    const beats = (cfg.ttsBeats || [1]).filter((b) => b <= count);
    const out = {
        beats: beats.length ? beats : [1],
        count,
        meter: cfg.meter,
        rand: !!cfg.randomize,
        subdivisions: cfg.subdiv || 1,
        gapCycles: cfg.gapCycles || 0,
        lang,
    };
    if (cfg.dispMode && cfg.dispMode !== "auto") out.cascadeMode = cfg.dispMode;
    return JSON.stringify(out);
}

// A mixed cascade batch (rows tagged mode: "cascade"|"reading") -> the two
// engine jobs, exactly as CascadeComposite.buildJobs does.
function cascadeJobs(rows, lang) {
    const jobs = { cascade: [], cascade_reading: [] };
    for (const it of rows || []) {
        if (it.mode === "reading") {
            jobs.cascade_reading.push({ word: it.title, passage: it.text, wpm: it.wpm });
        } else {
            const beat_config = cascadeBeatConfig(it, lang);
            const job = { word: it.text, title: it.title, text: it.text,
                bpm: it.bpm, pattern: it.pattern, beat_config, lang,
                every: it.writingOn ? it.writeEvery : 0 };
            if (it.writingOn) {
                job.timeLimit = it.timeLimit;
                job.metroDuringWrite = it.metroWrite;
                job.strokeDemo = it.strokeDemo;
                job.showOutline = it.showOutline;
            }
            jobs.cascade.push(job);
        }
    }
    return Object.entries(jobs).filter(([, batch]) => batch.length > 0);
}

// Vocab card templates (VocabComposite BASE_TEMPLATES + Visual). An empty
// list on export/push = the backend's stock 5-template model.
const VOCAB_BASE_TEMPLATES = ["Meaning", "Reading", "Listening", "Writing", "Cloze Fill"];
const VOCAB_ALL_TEMPLATES = [...VOCAB_BASE_TEMPLATES, "Visual"];

// The selected set -> the list to send. Classic default (exactly the 5 base
// templates) sends [] so the engine uses its stock model.
function vocabTemplateList(selected) {
    const set = new Set(selected);
    const isClassic = set.size === VOCAB_BASE_TEMPLATES.length
        && VOCAB_BASE_TEMPLATES.every((t) => set.has(t));
    return isClassic ? [] : [...set];
}

// Post-process the generated registry: Cascade is a custom multi-mode
// builder, so swap the generic reading-only entry for the real thing.
(function installCascade() {
    for (const g of CARD_REGISTRY.groups) {
        g.types = g.types.map((t) => (t === "cascade_reading" ? "cascade" : t));
    }
    delete CARD_REGISTRY.specs.cascade_reading;
    CARD_REGISTRY.specs.cascade = {
        title: "Cascade", custom: "cascade", deck: "Studio::Cascade",
        description: "Metronome-synced word flash (writing optional) and timed "
            + "reading — the full cascade family.",
        fields: [], columns: [],
    };
})();

// Async progress packs (dictionaries, sentence packs) poll these routes.
const PACK_KINDS = {
    dict: { available: "/dict/available", download: "/dict/download",
        status: "/dict/status", del: "/dict", listKey: "dictionaries",
        importRoute: "/dict/import-stardict",
        importLabel: "Import StarDict (.ifo/.idx/.dict path)" },
    sentences: { available: "/sentences/available", download: "/sentences/download",
        status: "/sentences/status", del: "/sentences", listKey: "packs",
        importRoute: "/sentences/import",
        importLabel: "Import sentence file (.db/.tsv/.csv path)" },
};

/* ------------------------------------------------------------------ */
/* DOM toolkit for the v4 screens                                      */
/*                                                                     */
/* Icons are drawn from their own path data (lucide's, as in the v4    */
/* design) rather than obsidian.setIcon, so the workspace looks the    */
/* same on every Obsidian version and on mobile. Everything else is    */
/* plain elements styled by styles.css on the vault's own variables.   */
/* ------------------------------------------------------------------ */

const V4_ICONS = {
    plus: ["M5 12h14", "M12 5v14"],
    refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
    layers: ["m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z", "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65", "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"],
    template: ["r:3,3,18,7,1", "r:3,14,9,7,1", "r:16,14,5,7,1"],
    languages: ["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"],
    book: ["M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z", "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"],
    inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
    x: ["M18 6 6 18", "m6 6 12 12"],
    check: ["M18 6 7 17l-5-5", "m22 10-7.5 7.5L13 16"],
    chart: ["M3 3v16a2 2 0 0 0 2 2h16", "M18 17V9", "M13 17V5", "M8 17v-3"],
    flame: ["M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"],
    arrowL: ["m12 19-7-7 7-7", "M19 12H5"],
    arrowR: ["m12 5 7 7-7 7", "M5 12h14"],
    arrowUp: ["m5 12 7-7 7 7", "M12 19V5"],
    arrowDown: ["M12 5v14", "m19 12-7 7-7-7"],
    chevUpDown: ["m7 15 5 5 5-5", "m7 9 5-5 5 5"],
    more: ["c:12,5,1", "c:12,12,1", "c:12,19,1"],
    gear: ["c:12,12,3", "M12 2v3", "M12 19v3", "M4.2 4.2l2.1 2.1", "M17.7 17.7l2.1 2.1", "M2 12h3", "M19 12h3", "M4.2 19.8l2.1-2.1", "M17.7 6.3l2.1-2.1"],
    dictionary: ["M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20", "m8 13 4-7 4 7", "M9.1 11h5.7"],
    quote: ["M17 6H3", "M21 12H8", "M21 18H8", "M3 12v6"],
    wrench: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"],
    scan: ["M3 7V5a2 2 0 0 1 2-2h2", "M17 3h2a2 2 0 0 1 2 2v2", "M21 17v2a2 2 0 0 1-2 2h-2", "M7 21H5a2 2 0 0 1-2-2v-2", "M7 8h8", "M7 12h10", "M7 16h6"],
    eye: ["M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0", "c:12,12,3"],
    pen: ["M12 20h9", "M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"],
    clock: ["c:12,12,10", "M12 6v6l4 2"],
    play: ["M6 3 20 12 6 21Z"],
};

function lsIcon(parent, name, size) {
    const doc = parent.ownerDocument || document;
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg");
    const sz = String(size || 20);
    for (const [k, v] of [["width", sz], ["height", sz], ["viewBox", "0 0 24 24"], ["fill", "none"],
        ["stroke", "currentColor"], ["stroke-width", "1.75"], ["stroke-linecap", "round"],
        ["stroke-linejoin", "round"], ["class", "lingua-icon"], ["aria-hidden", "true"]]) {
        svg.setAttribute(k, v);
    }
    for (const d of V4_ICONS[name] || []) {
        let node;
        if (d.startsWith("c:")) {
            const [cx, cy, r] = d.slice(2).split(",");
            node = doc.createElementNS(NS, "circle");
            node.setAttribute("cx", cx); node.setAttribute("cy", cy); node.setAttribute("r", r);
        } else if (d.startsWith("r:")) {
            const [x, y, w, h, rx] = d.slice(2).split(",");
            node = doc.createElementNS(NS, "rect");
            node.setAttribute("x", x); node.setAttribute("y", y); node.setAttribute("width", w);
            node.setAttribute("height", h); node.setAttribute("rx", rx);
        } else {
            node = doc.createElementNS(NS, "path");
            node.setAttribute("d", d);
        }
        svg.appendChild(node);
    }
    parent.appendChild(svg);
    return svg;
}

/* Buttons. kind: "" (plain), "cta" (accent), "quiet", "link", "danger",
   "small", "warn", "on" — combinable. */
function lsButton(parent, text, kind, onClick, attrs) {
    // kind: space-separated variants ("cta", "small warn"); layout helpers
    // (push-right) and Obsidian's own mod-* classes pass through as they are.
    const variants = String(kind || "").split(/\s+/).filter(Boolean)
        .map((k) => (/^(push-|mod-)/.test(k) ? k : "is-" + k));
    const b = parent.createEl("button", { cls: ["lingua-btn", ...variants].join(" ") });
    if (text) b.createSpan({ text });
    for (const [k, v] of Object.entries(attrs || {})) b.setAttribute(k, v);
    if (onClick) b.addEventListener("click", (e) => onClick(e, b));
    return b;
}

function lsIconButton(parent, icon, label, onClick, size) {
    const b = parent.createEl("button", { cls: "lingua-iconbtn", attr: { "aria-label": label, title: label } });
    lsIcon(b, icon, size || 20);
    if (onClick) b.addEventListener("click", (e) => onClick(e, b));
    return b;
}

/* Uppercase, letter-spaced section label (LIBRARY / READING in the vault). */
function lsKicker(parent, text) {
    return parent.createDiv({ cls: "lingua-kicker", text });
}

/* On/off switch. */
function lsSwitch(parent, on, onClick, label) {
    const b = parent.createEl("button", { cls: "lingua-switch" + (on ? " is-on" : ""),
        attr: { role: "switch", "aria-checked": on ? "true" : "false" } });
    if (label) b.setAttribute("aria-label", label);
    b.createSpan({ cls: "lingua-switch-knob" });
    if (onClick) b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e, b); });
    return b;
}

/* A checkbox mark: state true | false | "some". */
function lsCheck(parent, state) {
    const s = parent.createSpan({ cls: "lingua-cb" + (state === true ? " is-on" : state === "some" ? " is-some" : "") });
    s.setText(state === true ? "✓" : state === "some" ? "–" : "");
    return s;
}

/* Filter pill: label + count; `warn` paints the count orange. */
function lsPill(parent, label, n, on, warn, onClick) {
    const b = parent.createEl("button", { cls: "lingua-pill" + (on ? " is-on" : "") });
    b.createSpan({ text: label });
    if (n !== "" && n != null) b.createSpan({ cls: "lingua-pill-n" + (warn ? " is-warn" : ""), text: String(n) });
    b.addEventListener("click", onClick);
    return b;
}

/* Inputs that keep their focus and caret across a re-render carry a
   data-fkey; scroll containers carry data-scroll. render() snapshots both
   before emptying and puts them back after — so editing a cell, then
   tabbing to the next, survives the redraw the edit causes. */
function lsSnapshot(root) {
    const out = { scroll: {}, focus: null };
    root.querySelectorAll("[data-scroll]").forEach((el) => {
        out.scroll[el.getAttribute("data-scroll")] = [el.scrollTop, el.scrollLeft];
    });
    const a = root.ownerDocument && root.ownerDocument.activeElement;
    if (a && root.contains(a) && a.getAttribute("data-fkey")) {
        out.focus = { key: a.getAttribute("data-fkey"), start: a.selectionStart, end: a.selectionEnd };
    }
    return out;
}

function lsRestore(root, snap) {
    root.querySelectorAll("[data-scroll]").forEach((el) => {
        const v = snap.scroll[el.getAttribute("data-scroll")];
        if (v) { el.scrollTop = v[0]; el.scrollLeft = v[1]; }
    });
    if (snap.focus) {
        const el = root.querySelector(`[data-fkey="${CSS.escape(snap.focus.key)}"]`);
        if (el) {
            el.focus({ preventScroll: true });
            try { if (snap.focus.start != null) el.setSelectionRange(snap.focus.start, snap.focus.end); } catch (e) { /* not a text input */ }
        }
    }
}

/* A text input bound to a value: commits on change (blur / Enter). */
function lsInput(parent, value, opts) {
    const o = opts || {};
    const el = parent.createEl(o.multiline ? "textarea" : "input", { cls: o.cls || "lingua-input" });
    if (!o.multiline) el.setAttribute("type", "text");
    if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
    if (o.fkey) el.setAttribute("data-fkey", o.fkey);
    if (o.label) el.setAttribute("aria-label", o.label);
    if (o.dir) el.setAttribute("dir", o.dir);
    if (o.rows) el.setAttribute("rows", String(o.rows));
    el.value = value == null ? "" : String(value);
    if (o.onChange) el.addEventListener("change", () => o.onChange(el.value, el));
    if (o.onInput) el.addEventListener("input", () => o.onInput(el.value, el));
    if (o.onEnter) el.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); o.onEnter(el.value, el); } });
    return el;
}

function lsSelect(parent, value, options, onChange, cls) {
    const el = parent.createEl("select", { cls: cls || "lingua-select dropdown" });
    for (const o of options) {
        const opt = el.createEl("option", { text: o.label != null ? o.label : String(o.value) });
        opt.value = String(o.value);
        if (o.disabled) opt.disabled = true;
    }
    el.value = String(value == null ? "" : value);
    if (onChange) el.addEventListener("change", () => onChange(el.value, el));
    return el;
}

/* A card preview (v4CardView) drawn at `fontSize`; every size is in em, so
   the same card serves the Skim grid and the inspector. Card colours are the
   CARD's theme, not the vault's — the one place inline colour belongs. */
function lsCardPreview(parent, v, fontSize, opacity) {
    const c = parent.createDiv({ cls: "lingua-card" });
    c.style.cssText = `background:${v.bg};color:${v.ink};border-color:${v.line};font-size:${fontSize || "14px"};opacity:${opacity == null ? 1 : opacity}`;
    const top = c.createDiv({ cls: "lingua-card-top" });
    const tag = top.createDiv({ cls: "lingua-card-tag" });
    tag.style.color = v.ac;
    tag.createSpan({ cls: "lingua-card-dot" }).style.background = v.ac;
    tag.createSpan({ text: v.tag });
    tag.createSpan({ cls: "lingua-card-pos", text: v.pos }).style.color = v.mu;
    const gear = top.createDiv({ cls: "lingua-card-gear", text: "⚙" });
    gear.style.cssText = `border-color:${v.line};color:${v.mu}`;
    if (v.front) {
        const f = c.createDiv({ cls: "lingua-card-front" });
        if (v.heroBig) {
            // The ring is 10em of the CARD; the glyph inside takes the hero size.
            const h = f.createDiv({ cls: "lingua-card-hero" });
            h.style.cssText = `border-color:${v.line};color:${v.ac}`;
            h.createSpan({ text: v.heroBig }).style.fontSize = v.heroSize;
        }
        if (v.heroText) f.createDiv({ cls: "lingua-card-herotext", text: v.heroText });
        if (v.sub) f.createDiv({ cls: "lingua-card-sub", text: v.sub }).style.color = v.mu;
        if (v.writeBox) {
            const w = f.createDiv({ cls: "lingua-card-write" });
            w.style.borderColor = v.line;
            w.createDiv({ cls: "lingua-card-write-v" }).style.borderColor = v.line;
            w.createDiv({ cls: "lingua-card-write-h" }).style.borderColor = v.line;
        }
        if (v.prompt) f.createDiv({ cls: "lingua-card-prompt", text: v.prompt }).style.color = v.mu;
    } else {
        const bk = c.createDiv({ cls: "lingua-card-back" });
        const head = bk.createDiv({ cls: "lingua-card-backhead" });
        if (v.chars.length) {
            const cs = head.createDiv({ cls: "lingua-card-chars" });
            cs.style.cssText = `font-size:${v.heroSize};color:${v.ac}`;
            for (const ch of v.chars) cs.createSpan({ text: ch.t }).style.borderBottomColor = ch.c;
        }
        if (v.title) head.createDiv({ cls: "lingua-card-title", text: v.title });
        if (v.syl.length) {
            const row = head.createDiv({ cls: "lingua-card-sylrow" });
            const ss = row.createDiv({ cls: "lingua-card-syl" });
            for (const s of v.syl) ss.createSpan({ text: s.t }).style.color = s.c;
            const play = row.createDiv({ cls: "lingua-card-play", text: "▶" });
            play.style.cssText = `background:${v.ac};color:${v.bg}`;
        }
        if (v.sub) head.createDiv({ cls: "lingua-card-sub", text: v.sub }).style.color = v.mu;
        for (const b of v.blocks) {
            const blk = bk.createDiv({ cls: "lingua-card-block" });
            blk.style.borderTopColor = v.line;
            blk.createDiv({ cls: "lingua-card-blabel", text: b.l }).style.color = v.mu;
            blk.createDiv({ cls: "lingua-card-btext", text: b.t }).style.fontSize = b.size;
            if (b.t2) blk.createDiv({ cls: "lingua-card-bmore", text: b.t2 }).style.color = v.mu;
            if (b.t3) blk.createDiv({ cls: "lingua-card-bmore", text: b.t3 }).style.color = v.mu;
        }
    }
    return c;
}

/* POST that answers null when the route does not exist (404/405) — for a
   route the engine may not have yet — and otherwise behaves like call(). */
async function callOptional(kind, base, path, body) {
    let res;
    try {
        res = await obsidian.requestUrl({
            url: String(base).replace(/\/$/, "") + path, method: "POST",
            contentType: "application/json", body: JSON.stringify(body), throw: false });
    } catch (e) {
        throw new Error(serverDownMessage(kind, base));
    }
    if (!res || res.status <= 0) throw new Error(serverDownMessage(kind, base));
    if (res.status === 404 || res.status === 405) return null;
    let json = null;
    try { json = res.json; } catch (e) { /* non-JSON body */ }
    if (res.status >= 400) {
        const detail = json && (json.detail || json.error);
        throw new Error(detail ? String(detail) : `HTTP ${res.status} from ${path}`);
    }
    return json;
}

/* The v2 family exporter on the LinguaStudio engine: one call takes every
   out as {family, deck, notes:[{fields, tags, skip}]} (v4BatchToFamilyGroups)
   and carries themes, accessibility flags and per-template skips. Until the
   engine answers these routes, exports fall back to the classic routes
   (v4ExportJobs) — automatically, per call. */
const FAMILY_ROUTES = { push: "/families/push", export: "/families/export" };

/* A yes/no question as a modal. Resolves true on the confirming button. */
function lsConfirm(app, title, body, cta) {
    return new Promise((resolve) => {
        const m = new obsidian.Modal(app);
        let answered = false;
        m.titleEl.setText(title);
        m.modalEl.addClass("lingua-modal");
        m.contentEl.createEl("p", { cls: "lingua-modal-text", text: body });
        const row = m.contentEl.createDiv({ cls: "lingua-modal-actions" });
        lsButton(row, "Cancel", "", () => m.close());
        lsButton(row, cta || "OK", "cta", () => { answered = true; m.close(); });
        m.onClose = () => resolve(answered);
        m.open();
    });
}

const V4_SCREEN_TITLES = { inbox: "Inbox", review: "Review", studio: "Card Studio", stats: "Stats",
    manage: "Manage", dictionary: "Dictionary", sentences: "Sentences", tools: "Import & OCR" };
const V4_SCREEN_RENDER = { batch: "screenBatch", inbox: "screenInbox", review: "screenReview",
    studio: "screenStudio", stats: "screenStats", manage: "screenManage", stack: "screenStack",
    dictionary: "screenDictionary", sentences: "screenSentences", builders: "screenBuilders", tools: "screenTools" };

class LinguaMainView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.lang = langByVault(plugin.activeLang() || plugin.settings.defaultLang);
        this.screen = "batch";
        this.sub = { manage: "languages", studio: "catalog", builders: "builders" };
        this.builderType = null;
        this.stackId = null;
        // Transient UI state of the batch screen (never persisted).
        this.ui = {
            tab: "words", filter: "all", sel: [], addQ: "",
            frOpen: false, frFind: "", frRep: "", frField: "Example",
            fillOpen: false, rulesOpen: false,
            rd: { cond: "tone3", val: "", act: "theme", aval: "washi" },
            sfK: "Example", sfV: "", copyFrom: "",
            skF: "all", skSel: null, skSide: "front", seen: {}, skLimit: 120,
            catSel: "Vocab", catF: "all", catQ: "",
            inboxSel: [], inboxQ: "", inboxTarget: "",
        };
        // Legacy tool screens keep their own state.
        this.dict = { query: "", results: [], total: 0, offset: 0, busy: false };
        this.cloze = { word: "", context: "", result: null };
        this.inventoryTerms = null;
        this.studio = { models: null, sel: null, template: null, draft: {} };
        this.tools = { ocrText: "", ocrTarget: "", images: [], imgQuery: "",
            stackSel: new Set(), whisperText: "" };
        this.tts = { engine: plugin.settings.ttsDefaultEngine || "edge", voices: null,
            voice: plugin.settings.ttsDefaultVoice || "", text: "",
            cacheBytes: null, previewAudio: null };
        this.sent = { word: "", results: [], busy: false };
        this.packs = { dict: null, sentences: null };
        this.aiProbe = null;
        this.stats = null;
        this.cascade = {
            mode: "cascade", title: "", text: "",
            bpm: 80, pattern: "cross", meter: "4/4", dispMode: "auto",
            ttsBeats: [1], gapCycles: 1, subdiv: 1, randomize: false,
            writingOn: false, writeEvery: 3, timeLimit: 15, metroWrite: false,
            strokeDemo: true, showOutline: true, wpm: 120,
        };
    }

    getViewType() { return MAIN_VIEW; }
    getIcon() { return "languages"; }
    getDisplayText() { return "Lingua · " + this.screenTitle(); }

    screenTitle() {
        switch (this.screen) {
            case "batch": { const b = this.batch(); return b ? b.name : this.lang.name; }
            case "stack": { const st = this.plugin.v4Stack(this.stackId); return st ? st.name : "Stacks"; }
            case "builders": return this.builderType && specFor(this.builderType)
                ? specFor(this.builderType).title : "Builders";
            default: return V4_SCREEN_TITLES[this.screen] || "Lingua";
        }
    }

    getState() {
        const st = super.getState();
        st.lang = this.lang.vault;
        st.screen = this.screen;
        st.manage = this.sub.manage;
        st.builderType = this.builderType;
        st.stack = this.stackId;
        return st;
    }

    async setState(state, result) {
        if (state) {
            if (state.lang) this.lang = langByVault(state.lang);
            // Saved states from the 15-tab layout carry `section`.
            const route = state.screen ? v4RouteFor(state.screen)
                : state.section ? v4RouteFor(state.section) : null;
            if (route) this.applyRoute(route);
            if (state.manage) this.sub.manage = state.manage;
            if (state.builderType && specFor(state.builderType)) this.builderType = state.builderType;
            if (state.stack) this.stackId = state.stack;
            if (state.batch) await this.plugin.v4SetCur(state.batch);
        }
        await super.setState(state, result);
        this.render();
    }

    async onOpen() {
        this.contentEl.addClass("lingua-v4");
        this.plugin.requestBackendStart();
        // Skim: ← → move, Space flips, X skips — only while this view is the
        // active one and the key isn't typing into a field.
        this.registerDomEvent(this.contentEl.ownerDocument || document, "keydown", (e) => this.onKey(e));
        this.render();
    }

    applyRoute(route) {
        this.screen = route.screen;
        if (route.sub && (route.screen === "manage" || route.screen === "studio" || route.screen === "builders")) {
            this.sub[route.screen] = route.sub;
        }
    }

    /* Go somewhere: {screen, sub?, batch?, stack?, builderType?, tab?}. */
    async go(route) {
        const r = typeof route === "string" ? v4RouteFor(route) : Object.assign({}, route);
        this.applyRoute(r);
        if (r.batch) {
            if (r.batch !== this.plugin.v4Store().cur) {
                this.ui.sel = []; this.ui.filter = "all"; this.ui.skF = "all"; this.ui.skSel = null;
            }
            await this.plugin.v4SetCur(r.batch);
        }
        if (r.tab) this.ui.tab = r.tab;
        if (r.screen === "stats") this.stats = null;   // fresh numbers each visit
        if (r.stack) this.stackId = r.stack;
        if (r.builderType !== undefined) this.builderType = r.builderType;
        this.render();
        this.plugin.refreshNav();
    }

    // Legacy screens navigate by section name.
    setSection(name, builderType) {
        this.go(Object.assign(v4RouteFor(name), builderType !== undefined ? { builderType } : {}));
    }

    setLang(code) {
        this.lang = langByVault(code);
        this.inventoryTerms = null;
        this.stats = null;
        this.ui.sel = []; this.ui.skSel = null; this.ui.inboxSel = [];
        this.render();
    }

    batch() {
        return this.plugin.v4CurFor(this.lang.vault);
    }

    isMandarin() {
        return isMandarinLang(this.lang.vault);
    }

    /* ----- render shell ----- */

    render() {
        const root = this.contentEl;
        const snap = lsSnapshot(root);
        root.empty();
        root.addClass("lingua-v4");
        root.toggleClass("is-compact", this.plugin.settings.density === "compact");
        this.busyEl = root.createDiv({ cls: "lingua-busy" });
        this.refreshBusy();
        const screen = root.createDiv({ cls: "lingua-screen lingua-screen-" + this.screen });
        const fn = V4_SCREEN_RENDER[this.screen] || "screenBatch";
        try {
            this[fn](screen);
        } catch (e) {
            console.error("Lingua: screen failed to draw", e);
            screen.createDiv({ cls: "lingua-error", text: `This screen failed to draw — ${e.message || e}` });
        }
        lsRestore(root, snap);
        if (this.leaf && this.leaf.updateHeader) this.leaf.updateHeader();
    }

    // Coalesce redraws while a run of lookups lands word by word.
    scheduleRender() {
        if (this._renderT) return;
        this._renderT = window.setTimeout(() => { this._renderT = null; this.render(); }, 30);
    }

    refreshBusy() {
        if (!this.busyEl) return;
        const ops = this.plugin.opLabels();
        this.busyEl.empty();
        this.busyEl.toggleClass("is-on", ops.length > 0);
        if (ops.length) {
            this.busyEl.createSpan({ cls: "lingua-busy-dot" });
            this.busyEl.createSpan({ text: ops[ops.length - 1] + (ops.length > 1 ? ` (+${ops.length - 1})` : "") });
            this.busyEl.setAttribute("title", ops.join("\n"));
        }
    }

    onKey(e) {
        if (this.app.workspace.getActiveViewOfType(LinguaMainView) !== this) return;
        if (e.key === "Escape" && this.ui.fillOpen) { this.ui.fillOpen = false; this.render(); return; }
        if (this.screen !== "batch" || this.ui.tab !== "skim") return;
        const t = e.target;
        if (t && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable)) return;
        if (e.key === "ArrowRight") { e.preventDefault(); this.skMove(1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); this.skMove(-1); }
        else if (e.key === " ") { e.preventDefault(); this.ui.skSide = this.ui.skSide === "front" ? "back" : "front"; this.render(); }
        else if (e.key === "x" || e.key === "X") { e.preventDefault(); this.toggleSkip(); }
    }

    /* A page for the screens that are one column of content. */
    page(el, title, sub) {
        const p = el.createDiv({ cls: "lingua-page", attr: { "data-scroll": "page-" + this.screen } });
        const inner = p.createDiv({ cls: "lingua-page-inner" });
        const head = inner.createDiv({ cls: "lingua-page-head" });
        head.createDiv({ cls: "lingua-h1", text: title });
        if (sub) head.createDiv({ cls: "lingua-sub", text: sub });
        return inner;
    }

    /* Segmented sub-tabs (Manage, Card Studio, Builders). */
    segmented(el, key, items) {
        const bar = el.createDiv({ cls: "lingua-seg" });
        for (const [id, label] of items) {
            const b = bar.createEl("button", { cls: "lingua-seg-item" + (this.sub[key] === id ? " is-on" : ""), text: label });
            b.addEventListener("click", () => { this.sub[key] = id; this.render(); });
        }
        return bar;
    }

    /* ----- model mutations (always through the plugin store) ----- */

    async mut(fn, id) {
        const b = id ? this.plugin.v4Batch(id) : this.batch();
        if (!b) return null;
        const out = await this.plugin.v4Mut(b.id, fn);
        this.scheduleRender();
        this.plugin.refreshNav();
        return out;
    }

    mutWords(ids, fn, batchId) {
        return this.mut((x) => ({ words: x.words.map((w) => (ids.includes(w.id) ? Object.assign({}, w, fn(w)) : w)) }), batchId);
    }

    /* ================= Batch ================= */

    screenBatch(el) {
        const b = this.batch();
        if (!b) { this.emptyBatches(el); return; }
        const s = v4Summary(b);
        const wrap = el.createDiv({ cls: "lingua-batch", attr: { "data-scroll": "batch-narrow" } });

        const head = wrap.createDiv({ cls: "lingua-batch-head" });
        const tl = head.createDiv({ cls: "lingua-batch-title" });
        lsInput(tl, b.name, { cls: "lingua-title-input", fkey: "batch-name", label: "Batch name",
            onChange: (v) => { if (v.trim()) this.mut(() => ({ name: v.trim() })); } });
        const meta = [b.source || "", b.lastExport ? (b.lastExport.mode === "push" ? "pushed " : "exported ") + v4Ago(b.lastExport.at) : ""]
            .filter(Boolean).join(" · ");
        tl.createDiv({ cls: "lingua-sub", text: meta });
        const acts = head.createDiv({ cls: "lingua-batch-actions" });
        lsIconButton(acts, "more", "More", (e) => this.batchMenu(e, b));
        lsButton(acts, "Export .apkg", "", (e, btn) => this.exportBatch(b.id, "export", btn));
        lsButton(acts, `Push ${s.live} card${s.live === 1 ? "" : "s"}`, "cta", (e, btn) => this.exportBatch(b.id, "push", btn));

        const tiles = wrap.createDiv({ cls: "lingua-tiles" });
        const tile = (icon, n, label, warn) => {
            const t = tiles.createDiv({ cls: "lingua-tile" + (warn ? " is-warn" : "") });
            lsIcon(t.createDiv({ cls: "lingua-tile-icon" }), icon, 22);
            t.createDiv({ cls: "lingua-tile-n", text: String(n) });
            t.createDiv({ cls: "lingua-tile-label", text: label });
        };
        tile("book", s.words, s.words === 1 ? "word" : "words");
        tile("layers", s.types, s.types === 1 ? "card type" : "card types");
        tile("check", s.live, s.live === 1 ? "card" : "cards");
        tile("flame", s.needN, "to check", s.needN > 0);

        const tabs = wrap.createDiv({ cls: "lingua-tabs", attr: { role: "tablist" } });
        [["words", "Words", s.words + " words", s.needN ? s.needN + " need a look" : "", "warn"],
         ["types", "Card types", s.types + " types", "", ""],
         ["skim", "Skim", s.live + " cards", s.changed ? s.changed + " changed" : "", "accent"]]
            .forEach(([id, label, n, badge, tone], i) => {
                const on = this.ui.tab === id;
                const t = tabs.createEl("button", { cls: "lingua-tab" + (on ? " is-on" : ""), attr: { role: "tab", "aria-selected": on ? "true" : "false" } });
                t.createSpan({ cls: "lingua-tab-n", text: String(i + 1) });
                t.createSpan({ text: label });
                t.createSpan({ cls: "lingua-tab-badge" + (badge ? " is-" + tone : ""), text: "· " + (badge || n) });
                t.addEventListener("click", () => { this.ui.tab = id; this.ui.fillOpen = false; this.render(); });
            });

        const body = wrap.createDiv({ cls: "lingua-tabbody lingua-tabbody-" + this.ui.tab });
        if (this.ui.tab === "types") this.tabTypes(body, b, s);
        else if (this.ui.tab === "skim") this.tabSkim(body, b, s);
        else this.tabWords(body, b, s);
    }

    emptyBatches(el) {
        const p = this.page(el, this.lang.name, "No batches in " + this.lang.name + " yet.");
        const card = p.createDiv({ cls: "lingua-panel lingua-empty-hero" });
        card.createDiv({ cls: "lingua-empty-glyph", text: (V4_LANG_META[this.lang.vault] || ["文"])[0].slice(0, 1) });
        card.createDiv({ cls: "lingua-h2", text: "Start with a word list" });
        card.createDiv({ cls: "lingua-muted", text: "A batch is one word list that becomes many card types. "
            + "Paste words, pick a frequency list, pull what you captured in your notes, read a Boox page, or rebuild an Anki deck." });
        lsButton(card.createDiv({ cls: "lingua-row" }), "New batch", "cta", () => this.plugin.openNewBatch());
        const inbox = this.plugin.pendingFor(this.lang.vault).length;
        if (inbox) {
            lsButton(card.querySelector(".lingua-row"), `Inbox · ${inbox} captured`, "", () => this.go({ screen: "inbox" }));
        }
    }

    batchMenu(evt, b) {
        const menu = new obsidian.Menu();
        menu.addItem((i) => i.setTitle("Duplicate batch").setIcon("copy").onClick(async () => {
            const copy = await this.plugin.v4Duplicate(b.id);
            if (copy) this.go({ screen: "batch", batch: copy.id });
        }));
        const stacks = this.plugin.v4Stacks();
        for (const st of stacks) {
            if ((st.steps || []).includes(b.id)) continue;
            menu.addItem((i) => i.setTitle(`Add to stack “${st.name}”`).setIcon("layers").onClick(async () => {
                await this.plugin.v4MutStack(st.id, (x) => ({ steps: [...(x.steps || []), b.id] }));
                new obsidian.Notice(`${b.name} → ${st.name}`);
            }));
        }
        menu.addItem((i) => i.setTitle("New stack from this batch").setIcon("layers").onClick(async () => {
            const st = await this.plugin.v4AddStack(b.name, [b.id]);
            this.go({ screen: "stack", stack: st.id });
        }));
        menu.addSeparator();
        menu.addItem((i) => i.setTitle("Delete batch…").setIcon("trash-2").onClick(() => this.plugin.confirmDeleteBatch(b.id)));
        menu.showAtMouseEvent(evt);
    }

    /* ----- Words tab ----- */

    tabWords(el, b, s) {
        const u = this.ui;
        const zh = this.isMandarin();
        const readingLabel = zh ? "Pinyin" : "Reading";
        const ids = new Set(b.words.map((w) => w.id));
        u.sel = u.sel.filter((id) => ids.has(id));

        const bar = el.createDiv({ cls: "lingua-toolbar" });
        lsInput(bar, u.addQ, {
            cls: "lingua-input lingua-add", fkey: "words-add", label: "Add words",
            placeholder: `Add words — Enter fills ${zh ? "pinyin" : "reading"}, meaning, example, audio`,
            onInput: (v) => { u.addQ = v; },
            onEnter: (v) => {
                const words = v4SplitWords(v);
                if (!words.length) return;
                u.addQ = "";
                this.addWords(b.id, words, "Typed");
            },
        });
        lsButton(bar, "Find & replace", u.frOpen ? "on" : "", () => { u.frOpen = !u.frOpen; this.render(); });
        const fillWrap = bar.createDiv({ cls: "lingua-popwrap" });
        lsButton(fillWrap, "Fill column ▾", u.fillOpen ? "on" : "", () => { u.fillOpen = !u.fillOpen; this.render(); });
        const rulesBtn = lsButton(bar, "Rules", u.rulesOpen ? "on" : "", () => { u.rulesOpen = !u.rulesOpen; this.render(); });
        rulesBtn.createSpan({ cls: "lingua-muted", text: (b.rules || []).filter((r) => r.on).length + " on" });

        if (u.fillOpen) {
            const scope = u.sel.length ? u.sel : b.words.map((w) => w.id);
            const inScope = (pred) => scope.filter((id) => { const w = b.words.find((x) => x.id === id); return w && pred(w); }).length;
            el.createDiv({ cls: "lingua-scrim", attr: { "aria-hidden": "true" } })
                .addEventListener("click", () => { u.fillOpen = false; this.render(); });
            const pop = fillWrap.createDiv({ cls: "lingua-pop lingua-pop-right" });
            pop.createDiv({ cls: "lingua-pop-head", text: u.sel.length
                ? `Applies to ${u.sel.length} selected word${u.sel.length === 1 ? "" : "s"}`
                : `Applies to all ${b.words.length} words · select rows to narrow` });
            const opt = (label, sub, run) => {
                const o = pop.createEl("button", { cls: "lingua-pop-item" });
                o.createDiv({ text: label });
                o.createDiv({ cls: "lingua-pop-sub", text: sub });
                o.addEventListener("click", () => { u.fillOpen = false; this.render(); run(); });
            };
            opt("Examples — sentence corpus, then AI", inScope((w) => !w.Sent) + " empty in scope",
                () => this.fillExamples(b.id, scope));
            opt("Meanings — dictionary", inScope((w) => !v4EffMeaning(w, b) && (w.senses || []).length < 2) + " empty in scope",
                () => this.lookupWords(b.id, scope.filter((id) => { const w = b.words.find((x) => x.id === id); return w && !w.M; })));
            opt("Audio — TTS for missing", inScope((w) => !w.audio) + " missing in scope",
                () => this.resolveAudio(b.id, scope.filter((id) => { const w = b.words.find((x) => x.id === id); return w && !w.audio; })));
            if (zh) opt("Traditional + Zhuyin — dictionary", "Overwrites in scope", () => this.fillTradZhuyin(b.id, scope));
        }

        if (u.frOpen) this.findReplacePanel(el, b, readingLabel);
        if (u.rulesOpen) this.rulesPanel(el, b);

        // flag filters
        const fl = el.createDiv({ cls: "lingua-pills" });
        const counts = { missing: 0, senses: 0, audio: 0, conf: 0 };
        s.flags.forEach((f) => f.forEach((k) => { counts[k]++; }));
        [["all", "All", b.words.length], ["need", "Needs a look", s.needN],
         ...["missing", "senses", "audio", "conf"].filter((k) => counts[k]).map((k) => [k, V4_FLAG_TXT[k], counts[k]])]
            .forEach(([id, label, n]) => lsPill(fl, label, n, u.filter === id, id !== "all" && n > 0,
                () => { u.filter = id; this.render(); }));

        const shown = b.words.filter((w, i) => (u.filter === "all" ? true
            : u.filter === "need" ? s.flags[i].length : s.flags[i].includes(u.filter)));

        if (u.sel.length) this.selectionBar(el, b, readingLabel);

        // the sheet
        const scroller = el.createDiv({ cls: "lingua-sheet-wrap", attr: { "data-scroll": "words-" + b.id } });
        const sheet = scroller.createDiv({ cls: "lingua-sheet" });
        const hdr = sheet.createDiv({ cls: "lingua-sheet-row lingua-sheet-head" });
        const allOn = shown.length && u.sel.length === shown.length;
        const allBtn = hdr.createEl("button", { cls: "lingua-cb-btn", attr: { "aria-label": "Select all shown" } });
        lsCheck(allBtn, allOn ? true : u.sel.length ? "some" : false);
        allBtn.addEventListener("click", () => { u.sel = allOn ? [] : shown.map((w) => w.id); this.render(); });
        for (const h of ["Word", readingLabel, "Meaning", "Example", "Audio", "Status"]) hdr.createSpan({ text: h });

        const all = v4Cards(b);
        // A word's source is worth showing only where it differs from most.
        const srcN = {};
        b.words.forEach((w) => { srcN[w.src || ""] = (srcN[w.src || ""] || 0) + 1; });
        const usual = Object.keys(srcN).sort((x, y) => srcN[y] - srcN[x])[0];
        const liveBy = {};
        for (const c of all) if (c.w && !v4Skipped(b, c)) liveBy[c.w.id] = (liveBy[c.w.id] || 0) + 1;
        for (const w of shown) {
            const i = b.words.indexOf(w);
            const flags = s.flags[i];
            const on = u.sel.includes(w.id);
            const M = v4EffMeaning(w, b);
            const row = sheet.createDiv({ cls: "lingua-sheet-row" + (on ? " is-sel" : "") });
            row.addEventListener("contextmenu", (e) => { e.preventDefault(); this.wordMenu(e, b, w); });
            const cb = row.createEl("button", { cls: "lingua-cb-btn", attr: { "aria-label": "Select " + w.S } });
            lsCheck(cb, on);
            cb.addEventListener("click", () => { u.sel = on ? u.sel.filter((x) => x !== w.id) : [...u.sel, w.id]; this.render(); });

            lsInput(row, w.S, { cls: "lingua-cell lingua-cell-word", fkey: "w:" + w.id + ":S", label: "Word", dir: "auto",
                onChange: (v) => { if (v.trim()) this.mutWords([w.id], () => ({ S: v.trim() }), b.id); } });
            lsInput(row, w.P, { cls: "lingua-cell lingua-cell-reading" + (w.P ? "" : " is-missing"), fkey: "w:" + w.id + ":P",
                placeholder: "—", label: readingLabel,
                onChange: (v) => this.mutWords([w.id], () => {
                    const P = zh ? v4PinyinMarks(v.trim()) : v.trim();
                    return zh ? { P, Z: v4Zhuyin(P) } : { P };
                }, b.id) });
            const mc = row.createDiv({ cls: "lingua-cell-wrap" });
            if ((w.senses || []).length > 1 && !M) {
                lsSelect(mc, "", [{ value: "", label: `Choose a sense (${w.senses.length})…` },
                    ...w.senses.map((t, j) => ({ value: String(j), label: t }))],
                    (v) => { if (v !== "") this.mutWords([w.id], (x) => ({ M: x.senses[+v] }), b.id); },
                    "lingua-cell lingua-cell-sense dropdown");
            } else {
                lsInput(mc, M, { cls: "lingua-cell" + (M ? "" : " is-missing"), fkey: "w:" + w.id + ":M",
                    placeholder: "Missing", label: "Meaning",
                    onChange: (v) => this.mutWords([w.id], () => ({ M: v.trim() }), b.id) });
            }
            lsInput(row, w.Sent, { cls: "lingua-cell", fkey: "w:" + w.id + ":Sent", dir: "auto",
                placeholder: "No example — Fill column adds one", label: "Example",
                onChange: (v) => this.mutWords([w.id], () => ({ Sent: v.trim() }), b.id) });
            const ac = row.createDiv({ cls: "lingua-cell-audio" });
            if (w.audio) {
                const p = ac.createEl("button", { cls: "lingua-audio-chip", attr: { "aria-label": "Play " + w.S } });
                p.createSpan({ cls: "lingua-audio-play", text: "▶" });
                p.createSpan({ text: w.audio });
                p.addEventListener("click", () => this.playWord(b, w));
            } else {
                lsButton(ac, "Make TTS", "warn small", () => this.resolveAudio(b.id, [w.id]));
            }
            const st = row.createDiv({ cls: "lingua-cell-status" });
            for (const f of flags) {
                if (f === "conf") continue;
                st.createSpan({ cls: "lingua-flag", text: V4_FLAG_TXT[f] });
            }
            if (flags.includes("conf")) {
                lsButton(st, "Looks right", "small", () => this.mutWords([w.id], () => ({ conf: 1 }), b.id))
                    .setAttribute("title", "Captured with low confidence (OCR) — confirm the word");
            }
            if (!flags.length) {
                const n = liveBy[w.id] || 0;
                st.createSpan({ cls: "lingua-muted", text: n + " cards" + (w.src && w.src !== usual ? " · " + w.src : "") });
            }
        }
        if (!shown.length) {
            sheet.createDiv({ cls: "lingua-sheet-empty", text: b.words.length
                ? "Nothing matches this filter."
                : "No words yet — type some above and press Enter, or bring them in from the Inbox." });
        }
    }

    findReplacePanel(el, b, readingLabel) {
        const u = this.ui;
        const keys = Object.assign({}, V4_FIELD_KEYS);
        if (readingLabel !== "Pinyin") { delete keys.Pinyin; keys.Reading = "P"; delete keys.Traditional; }
        if (!keys[u.frField]) u.frField = "Example";
        const k = keys[u.frField];
        const hits = u.frFind ? b.words.filter((w) => String(w[k] || "").includes(u.frFind)).length : 0;
        const p = el.createDiv({ cls: "lingua-panel lingua-inline-panel" });
        lsInput(p, u.frFind, { cls: "lingua-input is-narrow", fkey: "fr-find", placeholder: "Find", label: "Find",
            onInput: (v) => { u.frFind = v; this.scheduleRender(); } });
        lsInput(p, u.frRep, { cls: "lingua-input is-narrow", fkey: "fr-rep", placeholder: "Replace with", label: "Replace with",
            onInput: (v) => { u.frRep = v; } });
        p.createSpan({ cls: "lingua-muted", text: "in" });
        lsSelect(p, u.frField, Object.keys(keys).map((x) => ({ value: x })), (v) => { u.frField = v; this.render(); });
        p.createSpan({ cls: "lingua-muted", text: u.frFind ? `${hits} match${hits === 1 ? "" : "es"}` : "" });
        lsButton(p, "Replace all", "cta push-right", async () => {
            if (!u.frFind) return;
            await this.mut((x) => ({ words: x.words.map((w) => Object.assign({}, w, { [k]: String(w[k] || "").split(u.frFind).join(u.frRep) })) }));
            new obsidian.Notice(`Replaced in ${hits} word${hits === 1 ? "" : "s"}.`);
        });
    }

    rulesPanel(el, b) {
        const u = this.ui;
        const p = el.createDiv({ cls: "lingua-panel lingua-rules" });
        const head = p.createDiv({ cls: "lingua-rules-head" });
        head.createSpan({ cls: "lingua-strong", text: "Rules for this batch" });
        head.createSpan({ cls: "lingua-muted", text: "Run on every word, now and when you add more" });
        for (const r of b.rules || []) {
            const hits = b.words.filter((w) => v4CondHit(r, w)).length;
            const row = p.createDiv({ cls: "lingua-rule" + (r.on ? "" : " is-off") });
            lsSwitch(row, !!r.on, () => this.mut((x) => ({ rules: x.rules.map((y) => (y.id === r.id ? Object.assign({}, y, { on: y.on ? 0 : 1 }) : y)) })),
                "Rule on");
            row.createSpan({ cls: "lingua-rule-text", text: this.ruleLabel(r) });
            row.createSpan({ cls: "lingua-muted", text: hits + " word" + (hits === 1 ? "" : "s") });
            lsIconButton(row, "x", "Delete rule", () => this.mut((x) => ({ rules: x.rules.filter((y) => y.id !== r.id) })), 16);
        }
        if (!(b.rules || []).length) p.createDiv({ cls: "lingua-muted lingua-rule-none", text: "No rules yet." });
        const tplNames = [...new Set((b.outs || []).flatMap((o) => (v4Wt(o.type) || { tpls: [] }).tpls))];
        const add = p.createDiv({ cls: "lingua-rule-add" });
        add.createSpan({ text: "If" });
        lsSelect(add, u.rd.cond, V4_CONDS.map((c) => ({ value: c.id, label: c.label + (c.unit ? " … " + c.unit : "") })),
            (v) => { u.rd = Object.assign({}, u.rd, { cond: v }); this.render(); });
        const cond = V4_CONDS.find((c) => c.id === u.rd.cond) || {};
        if (cond.val) lsInput(add, u.rd.val, { cls: "lingua-input is-tiny", fkey: "rd-val", label: "Value", onInput: (v) => { u.rd.val = v; } });
        add.createSpan({ text: "then" });
        lsSelect(add, u.rd.act, V4_ACTS.map((a) => ({ value: a.id, label: a.label })), (v) => {
            u.rd = Object.assign({}, u.rd, { act: v, aval: v === "skip" ? (tplNames[0] || "") : v === "theme" ? "washi" : v === "tag" ? "review" : "" });
            this.render();
        });
        if (u.rd.act === "skip") lsSelect(add, u.rd.aval, tplNames.map((n) => ({ value: n, label: "“" + n + "”" })), (v) => { u.rd.aval = v; });
        if (u.rd.act === "theme") lsSelect(add, u.rd.aval, V4_THEMES.map((t) => ({ value: t[0], label: t[1] })), (v) => { u.rd.aval = v; });
        if (u.rd.act === "tag") lsInput(add, u.rd.aval, { cls: "lingua-input is-tiny", fkey: "rd-tag", placeholder: "tag", label: "Tag", onInput: (v) => { u.rd.aval = v.replace(/^#/, ""); } });
        lsButton(add, "Add rule", "cta push-right", async () => {
            const r = Object.assign({ id: v4NextId("r"), on: 1 }, u.rd);
            if (cond.val && !String(r.val || "").trim()) { new obsidian.Notice("Give the rule a value."); return; }
            await this.mut((x) => ({ rules: [...(x.rules || []), r] }));
            new obsidian.Notice("Rule added · applies to all words");
        });
    }

    ruleLabel(r) {
        const th = V4_THEMES.find((t) => t[0] === r.aval);
        return r.act === "theme" && th ? v4RuleText(Object.assign({}, r, { aval: th[1] })) : v4RuleText(r);
    }

    selectionBar(el, b, readingLabel) {
        const u = this.ui;
        const keys = Object.assign({}, V4_FIELD_KEYS);
        if (readingLabel !== "Pinyin") { delete keys.Pinyin; keys.Reading = "P"; delete keys.Traditional; }
        if (!keys[u.sfK]) u.sfK = "Example";
        const p = el.createDiv({ cls: "lingua-selbar" });
        p.createSpan({ cls: "lingua-strong", text: u.sel.length + " selected" });
        p.createSpan({ cls: "lingua-muted", text: "Set" });
        lsSelect(p, u.sfK, Object.keys(keys).map((x) => ({ value: x })), (v) => { u.sfK = v; });
        p.createSpan({ cls: "lingua-muted", text: "to" });
        lsInput(p, u.sfV, { cls: "lingua-input is-narrow", fkey: "sf-val", label: "Value", onInput: (v) => { u.sfV = v; } });
        lsButton(p, "Apply", "cta", async () => {
            const k = keys[u.sfK];
            const n = u.sel.length;
            await this.mutWords(u.sel, () => ({ [k]: u.sfV }));
            new obsidian.Notice(`${u.sfK} set on ${n} word${n === 1 ? "" : "s"}.`);
        });
        p.createSpan({ cls: "lingua-vrule" });
        lsButton(p, "Look up again", "", () => this.lookupWords(b.id, [...u.sel], { force: true }));
        lsButton(p, "Remove", "danger", () => this.removeWords(b, [...u.sel]));
        lsButton(p, "Clear selection", "quiet push-right", () => { u.sel = []; this.render(); });
    }

    async removeWords(b, ids) {
        if (!ids.length) return;
        const n = ids.length;
        if (n > 3 && !(await lsConfirm(this.app, "Remove words", `Remove ${n} words from ${b.name}? Their cards and per-card edits go with them.`, "Remove"))) return;
        this.ui.sel = this.ui.sel.filter((x) => !ids.includes(x));
        await this.mut((x) => ({ words: x.words.filter((w) => !ids.includes(w.id)),
            ov: Object.fromEntries(Object.entries(x.ov || {}).filter(([k]) => !ids.some((id) => k.includes(":" + id + ":")))) }), b.id);
    }

    wordMenu(evt, b, w) {
        const menu = new obsidian.Menu();
        menu.addItem((i) => i.setTitle("Play audio").setIcon("volume-2").onClick(() => this.playWord(b, w)));
        menu.addItem((i) => i.setTitle("Look up again").setIcon("refresh-cw").onClick(() => this.lookupWords(b.id, [w.id], { force: true })));
        menu.addItem((i) => i.setTitle(w.image ? "Change image…" : "Find an image…").setIcon("image").onClick(() =>
            new ImagePickModal(this.app, this.plugin, w.S, v4EffMeaning(w, b), (file) => this.mutWords([w.id], () => ({ image: file }), b.id)).open()));
        menu.addItem((i) => i.setTitle("Relate to another saved term…").setIcon("link").onClick(() =>
            new RelateModal(this.app, this.plugin, b.lang || this.lang.vault, w.S).open()));
        menu.addSeparator();
        menu.addItem((i) => i.setTitle("Remove from batch").setIcon("x").onClick(() => this.removeWords(b, [w.id])));
        menu.showAtMouseEvent(evt);
    }

    /* ----- Card types tab ----- */

    /* Theme chips: click toggles the theme in the allow-list (the default
       stays in), ★ makes it the default. */
    themeChips(parent, list, def, onToggle, onStar) {
        const row = parent.createDiv({ cls: "lingua-themes" });
        for (const t of V4_THEMES) {
            const on = list.includes(t[0]), d = def === t[0];
            const chip = row.createDiv({ cls: "lingua-theme" + (on ? " is-on" : "") + (d ? " is-def" : "") });
            const pick = chip.createEl("button", { cls: "lingua-theme-pick",
                attr: { "aria-pressed": on ? "true" : "false", title: d ? "Default theme" : on ? "Learners can pick this — click to remove" : "Click to offer this theme" } });
            pick.style.cssText = `background:${t[2]};color:${t[3]}`;
            pick.createSpan({ cls: "lingua-theme-glyph", text: "字" }).style.color = t[4];
            pick.createSpan({ text: t[1] });
            pick.addEventListener("click", () => { if (!d) onToggle(t[0], on); });
            const star = chip.createEl("button", { cls: "lingua-theme-star", text: "★", attr: { "aria-label": "Make " + t[1] + " the default", title: "Make default" } });
            star.addEventListener("click", () => onStar(t[0]));
        }
        return row;
    }

    tabTypes(el, b, s) {
        const u = this.ui;
        const sc = el.createDiv({ cls: "lingua-scroll", attr: { "data-scroll": "types-" + b.id } });
        const inner = sc.createDiv({ cls: "lingua-types" });

        // batch defaults
        const def = inner.createDiv({ cls: "lingua-section" });
        const dh = def.createDiv({ cls: "lingua-section-head" });
        const dt = dh.createDiv();
        lsKicker(dt, "Batch defaults");
        dt.createDiv({ cls: "lingua-muted", text: "Every card type below uses these unless you change it there — or on a single card in Skim." });
        const others = this.plugin.v4Store().batches.filter((x) => x.id !== b.id);
        if (others.length) {
            const cp = dh.createDiv({ cls: "lingua-row" });
            lsSelect(cp, u.copyFrom, [{ value: "", label: "Copy settings from…" }, ...others.map((x) => ({ value: x.id, label: x.name }))],
                (v) => { u.copyFrom = v; });
            lsButton(cp, "Copy", "", async () => {
                const src = this.plugin.v4Batch(u.copyFrom);
                if (!src) return;
                const outs = (src.outs || []).filter((o) => v4TypeAvailable(o.type, b.lang || this.lang.vault)).map((o) => Object.assign({}, o));
                await this.mut(() => ({ outs: outs.length ? outs : b.outs, themes: [...(src.themes || [])], def: src.def,
                    flags: Object.assign({}, src.flags), rules: (src.rules || []).map((r) => Object.assign({}, r, { id: v4NextId("r") })), ov: {} }));
                new obsidian.Notice("Copied card types, themes and rules from " + src.name);
                u.copyFrom = "";
            });
        }
        def.createDiv({ cls: "lingua-muted lingua-label", text: "Themes learners can pick · ★ default" });
        this.themeChips(def, b.themes || [], b.def,
            (id, on) => this.mut((x) => ({ themes: on ? x.themes.filter((y) => y !== id) : [...(x.themes || []), id] })),
            (id) => this.mut((x) => ({ def: id, themes: (x.themes || []).includes(id) ? x.themes : [...(x.themes || []), id] })));
        const grid = def.createDiv({ cls: "lingua-2col" });
        const deckL = grid.createEl("label", { cls: "lingua-field" });
        deckL.createSpan({ cls: "lingua-muted", text: "Deck" });
        lsInput(deckL, b.deck, { fkey: "batch-deck", label: "Deck", onChange: (v) => { if (v.trim()) this.mut(() => ({ deck: v.trim() })); } });
        const a11y = grid.createDiv({ cls: "lingua-field" });
        a11y.createSpan({ cls: "lingua-muted", text: "Accessibility defaults · learner's ⚙ still wins" });
        for (const [k, label] of [["SensoryMute", "Mute sounds"], ["DyslexiaMode", "Dyslexia-friendly spacing"],
            ["MicroSteps", "Reveal the back step by step"], ["MetronomeOverlay", "Show the metronome"]]) {
            const on = !!(b.flags || {})[k];
            const r = a11y.createDiv({ cls: "lingua-toggle-row" });
            r.createSpan({ text: label });
            lsSwitch(r, on, () => this.mut((x) => ({ flags: Object.assign({}, x.flags, { [k]: on ? 0 : 1 }) })), label);
            r.addEventListener("click", () => this.mut((x) => ({ flags: Object.assign({}, x.flags, { [k]: on ? 0 : 1 }) })));
        }

        // card types
        const sec = inner.createDiv({ cls: "lingua-section" });
        const sh = sec.createDiv();
        lsKicker(sh, "Card types from these words");
        sh.createDiv({ cls: "lingua-muted", text: "Each one is built from the same word list. Fields are mapped for you." });
        const all = v4Cards(b);
        (b.outs || []).forEach((o, oi) => {
            const t = v4Wt(o.type);
            if (!t) return;
            const oc = all.filter((c) => c.oi === oi);
            const live = oc.filter((c) => !v4Skipped(b, c)).length;
            const card = sec.createDiv({ cls: "lingua-panel lingua-out" });
            const top = card.createDiv({ cls: "lingua-out-top" });
            const nm = top.createDiv({ cls: "lingua-out-name" });
            nm.createDiv({ cls: "lingua-h3", text: t.name });
            nm.createDiv({ cls: "lingua-muted", text: t.desc });
            top.createSpan({ cls: "lingua-muted", text: live + " cards" + (oc.length - live ? " · " + (oc.length - live) + " skipped" : "") });
            lsButton(top, "Skim", "small", () => { u.tab = "skim"; u.skF = oi; u.skSel = null; this.render(); });
            lsIconButton(top, "x", "Remove card type", () => this.removeOut(b, oi), 16);

            const tp = card.createDiv({ cls: "lingua-tpls" });
            t.tpls.forEach((name, i) => {
                const on = o.tpls.includes(i);
                const k = oc.filter((c) => c.ti === i && !v4Skipped(b, c)).length;
                const btn = tp.createEl("button", { cls: "lingua-tpl" + (on ? " is-on" : ""), attr: { "aria-pressed": on ? "true" : "false" } });
                lsCheck(btn, on);
                btn.createSpan({ text: name });
                if (on) btn.createSpan({ cls: "lingua-muted", text: String(k) });
                btn.addEventListener("click", () => this.mut((x) => ({ outs: x.outs.map((y, j) => {
                    if (j !== oi) return y;
                    const nx = on ? y.tpls.filter((z) => z !== i) : [...y.tpls, i].sort((p, q) => p - q);
                    return nx.length ? Object.assign({}, y, { tpls: nx }) : y;
                }) })));
            });
            card.createDiv({ cls: "lingua-map", text: t.map });
            const miss = v4MissingFor(b, oi);
            if (miss.count) {
                card.createDiv({ cls: "lingua-warn", text: `${miss.count} word${miss.count === 1 ? "" : "s"} missing ${miss.fields.join(", ")}`
                    + (miss.fields.includes("Image") ? " — right-click a word in Words to find an image, or drop this type"
                        : miss.fields.includes("Audio") ? " — Fill column → Audio fixes this" : "") });
            }
            const g = card.createDiv({ cls: "lingua-2col" });
            const th = g.createDiv({ cls: "lingua-field" });
            const defName = v4Theme(o.themes ? o.def : b.def)[1];
            const tr = th.createDiv({ cls: "lingua-toggle-row" });
            const lab = tr.createSpan({ text: "Themes: " });
            lab.createSpan({ cls: "lingua-muted", text: o.themes ? "custom · ★ " + defName : "batch default · " + defName });
            const flip = () => this.mut((x) => ({ outs: x.outs.map((y, j) => (j !== oi ? y
                : y.themes ? Object.assign({}, y, { themes: null, def: null }) : Object.assign({}, y, { themes: [...(x.themes || [])], def: x.def }))) }));
            lsSwitch(tr, !!o.themes, flip, "Custom themes");
            tr.addEventListener("click", flip);
            if (o.themes) {
                this.themeChips(th, o.themes, o.def,
                    (id, on) => this.mut((x) => ({ outs: x.outs.map((y, j) => (j !== oi ? y
                        : Object.assign({}, y, { themes: on ? y.themes.filter((z) => z !== id) : [...y.themes, id] }))) })),
                    (id) => this.mut((x) => ({ outs: x.outs.map((y, j) => (j !== oi ? y
                        : Object.assign({}, y, { def: id, themes: y.themes.includes(id) ? y.themes : [...y.themes, id] }))) })));
            }
            const subL = g.createEl("label", { cls: "lingua-field lingua-field-inline" });
            subL.createSpan({ cls: "lingua-muted", text: "Subdeck" });
            lsInput(subL, o.sub, { fkey: "sub-" + oi, label: "Subdeck",
                onChange: (v) => this.mut((x) => ({ outs: x.outs.map((y, j) => (j === oi ? Object.assign({}, y, { sub: v.trim() }) : y)) })) });
        });

        const addable = V4_WT.filter((t) => !(b.outs || []).some((o) => o.type === t.id) && v4TypeAvailable(t.id, b.lang || this.lang.vault));
        if (addable.length) {
            const ad = sec.createDiv({ cls: "lingua-add-types" });
            ad.createDiv({ cls: "lingua-muted", text: "Add a card type" });
            const gg = ad.createDiv({ cls: "lingua-add-grid" });
            for (const t of addable) {
                const btn = gg.createEl("button", { cls: "lingua-add-type" });
                btn.createDiv({ cls: "lingua-strong", text: "+ " + t.name });
                btn.createDiv({ cls: "lingua-muted", text: t.desc });
                btn.addEventListener("click", () => this.addOut(b, t.id));
            }
            ad.createDiv({ cls: "lingua-faint", text: "Sentence, dialogue, cloze and grammar cards are built from sentences — open them from Card Studio." });
        }
    }

    addOut(b, typeId) {
        const t = v4Wt(typeId);
        if (!t) return Promise.resolve();
        return this.mut((x) => ({ outs: [...(x.outs || []), { type: t.id, tpls: t.tpls.map((_, i) => i), themes: null, def: null, sub: t.name.replace(/ · /g, " ") }] }), b.id);
    }

    /* Removing an out shifts the ones after it, so per-card overrides are
       re-keyed rather than thrown away (keys start with the out index). */
    removeOut(b, oi) {
        return this.mut((x) => {
            const ov = {};
            for (const [k, v] of Object.entries(x.ov || {})) {
                const n = parseInt(k, 10);
                if (n === oi) continue;
                ov[n > oi ? (n - 1) + k.slice(String(n).length) : k] = v;
            }
            return { outs: x.outs.filter((_, j) => j !== oi), ov };
        });
    }

    /* ----- Skim tab ----- */

    skList(b) {
        const f = this.ui.skF;
        const all = v4Cards(b);
        return all.filter((c) => (f === "all" ? true
            : f === "changed" ? !!(b.ov || {})[c.key] && Object.keys(b.ov[c.key]).length
            : f === "skipped" ? v4Skipped(b, c) : c.oi === f));
    }

    seenKey(b, c) { return b.id + "|" + c.key; }

    skMove(d) {
        const b = this.batch();
        if (!b) return;
        const l = this.skList(b);
        if (!l.length) return;
        const i = Math.max(0, l.findIndex((c) => c.key === this.ui.skSel));
        const n = l[(i + d + l.length) % l.length];
        this.ui.skSel = n.key;
        this.ui.skSide = "front";
        this.ui.seen[this.seenKey(b, n)] = 1;
        this.render();
    }

    setOv(key, fn) {
        return this.mut((x) => {
            const cur = (x.ov || {})[key] || {};
            const nx = fn(cur);
            const ov = Object.assign({}, x.ov);
            if (!Object.keys(nx).length) delete ov[key]; else ov[key] = nx;
            return { ov };
        });
    }

    toggleSkip() {
        const b = this.batch();
        if (!b) return;
        const c = v4Cards(b).find((x) => x.key === this.ui.skSel) || this.skList(b)[0];
        if (!c) return;
        const sk = v4Skipped(b, c);
        this.setOv(c.key, (cur) => {
            const n = Object.assign({}, cur);
            const want = sk ? 1 : 0;
            const def = c.ruleSkip ? 0 : 1;
            if (want === def) delete n.inc; else n.inc = want;
            return n;
        });
    }

    tabSkim(el, b) {
        const u = this.ui;
        const all = v4Cards(b);
        const list = this.skList(b);
        const cur = list.find((c) => c.key === u.skSel) || list[0];
        const changedN = all.filter((c) => (b.ov || {})[c.key] && Object.keys(b.ov[c.key]).length).length;
        const skippedN = all.filter((c) => v4Skipped(b, c)).length;
        const seenN = all.filter((c) => u.seen[this.seenKey(b, c)]).length;

        const left = el.createDiv({ cls: "lingua-skim-main" });
        const fl = left.createDiv({ cls: "lingua-pills" });
        [["all", "All", all.length], ...(b.outs || []).map((o, oi) => [oi, (v4Wt(o.type) || { name: o.type }).name, all.filter((c) => c.oi === oi).length]),
         ["changed", "Changed", changedN], ["skipped", "Skipped", skippedN]]
            .forEach(([id, label, n]) => lsPill(fl, label, n, u.skF === id, false, () => { u.skF = id; u.skSel = null; this.render(); }));
        fl.createSpan({ cls: "lingua-muted push-right", text: `${seenN} of ${all.length} skimmed` });

        const sc = left.createDiv({ cls: "lingua-skim-grid-wrap", attr: { "data-scroll": "skim-" + b.id } });
        const grid = sc.createDiv({ cls: "lingua-skim-grid" });
        for (const c of list.slice(0, u.skLimit)) {
            const sk = v4Skipped(b, c);
            const ch = (b.ov || {})[c.key] && Object.keys(b.ov[c.key]).length;
            const isCur = cur && c.key === cur.key;
            const cell = grid.createEl("button", { cls: "lingua-skim-cell" + (isCur ? " is-cur" : ""), attr: { "aria-label": c.label } });
            const frame = cell.createDiv({ cls: "lingua-skim-frame" });
            lsCardPreview(frame, v4CardView(c.t.id, v4RowFor(b, c), c.ti, isCur && u.skSide === "back" ? "back" : "front", v4ThemeOf(b, c)), "6.2px", sk ? 0.35 : 1);
            if (sk || ch) {
                const own = (b.ov || {})[c.key] || {};
                frame.createSpan({ cls: "lingua-skim-badge" + (sk ? " is-skip" : ""),
                    text: sk ? (c.ruleSkip && !("inc" in own) ? "Rule: skip" : "Skipped") : "Changed" });
            }
            const cap = cell.createDiv({ cls: "lingua-skim-cap" });
            cap.createSpan({ cls: "lingua-skim-label", text: c.label });
            if (u.seen[this.seenKey(b, c)]) cap.createSpan({ cls: "lingua-ok", text: "✓" });
            cell.addEventListener("click", () => {
                u.skSide = isCur ? (u.skSide === "front" ? "back" : "front") : "front";
                u.skSel = c.key;
                u.seen[this.seenKey(b, c)] = 1;
                this.render();
            });
        }
        if (list.length > u.skLimit) {
            lsButton(sc.createDiv({ cls: "lingua-more-row" }), `Show more (${list.length - u.skLimit} left)`, "",
                () => { u.skLimit += 120; this.render(); });
        }
        if (!list.length) sc.createDiv({ cls: "lingua-sheet-empty", text: "No cards in this filter." });

        const aside = el.createDiv({ cls: "lingua-aside", attr: { "data-scroll": "skim-aside" } });
        if (!cur) { aside.createDiv({ cls: "lingua-aside-empty", text: "No cards in this filter." }); return; }
        const own = (b.ov || {})[cur.key] || {};
        const sk = v4Skipped(b, cur);
        const nav = aside.createDiv({ cls: "lingua-skim-nav" });
        lsIconButton(nav, "arrowL", "Previous (←)", () => this.skMove(-1));
        const tt = nav.createDiv({ cls: "lingua-skim-title" });
        tt.createDiv({ cls: "lingua-strong", text: cur.label });
        tt.createDiv({ cls: "lingua-muted", text: `${list.indexOf(cur) + 1} of ${list.length} · ${cur.t.name}` + (cur.tags.length ? " · #" + cur.tags.join(" #") : "") });
        lsIconButton(nav, "arrowR", "Next (→)", () => this.skMove(1));
        const big = aside.createDiv({ cls: "lingua-skim-big", attr: { role: "button", tabindex: "0", "aria-label": "Flip card" } });
        lsCardPreview(big, v4CardView(cur.t.id, v4RowFor(b, cur), cur.ti, u.skSide, v4ThemeOf(b, cur)), "13px", sk ? 0.45 : 1);
        big.addEventListener("click", () => { u.skSide = u.skSide === "front" ? "back" : "front"; u.seen[this.seenKey(b, cur)] = 1; this.render(); });
        const hints = aside.createDiv({ cls: "lingua-hints" });
        hints.createSpan({ text: "Click card or Space to flip" });
        hints.createSpan({ text: "X skips" });

        const box = aside.createDiv({ cls: "lingua-override" });
        const bh = box.createDiv({ cls: "lingua-override-head" });
        bh.createSpan({ cls: "lingua-h3", text: "This card only" });
        if (Object.keys(own).length) lsButton(bh, "Reset to batch", "link", () => this.setOv(cur.key, () => ({})));
        const inc = box.createDiv({ cls: "lingua-toggle-row" });
        const il = inc.createSpan({ cls: "lingua-col" });
        il.createSpan({ text: "Include in export" });
        il.createSpan({ cls: "lingua-small lingua-muted", text: cur.ruleSkip
            ? (sk ? "Skipped by rule: " : "Rule overridden: ") + cur.ruleSkip.replace(/^If /, "if ")
            : sk ? "Skipped by you" : "Included" });
        lsSwitch(inc, !sk, () => this.toggleSkip(), "Include in export");
        inc.addEventListener("click", () => this.toggleSkip());

        const allowed = cur.o.themes || b.themes || [];
        const inh = cur.ruleTheme || (cur.o.themes ? cur.o.def : b.def);
        const thL = box.createEl("label", { cls: "lingua-field" });
        thL.createSpan({ cls: "lingua-muted", text: "Theme" });
        lsSelect(thL, own.theme || "", [{ value: "", label: "Inherited · " + v4Theme(inh)[1] + (cur.ruleTheme ? " (rule)" : cur.o.themes ? " (card type)" : " (batch)") },
            ...allowed.map((id) => ({ value: id, label: v4Theme(id)[1] }))],
            (v) => this.setOv(cur.key, (c) => { const n = Object.assign({}, c); if (v) n.theme = v; else delete n.theme; return n; }),
            "lingua-select dropdown" + (own.theme ? " is-set" : ""));

        if (cur.ws) {
            box.createDiv({ cls: "lingua-muted lingua-small", text: "Games combine several words, so fields are edited in Words." });
            return;
        }
        const base = v4RowFor(Object.assign({}, b, { ov: {} }), cur);
        for (const k of V4_EDITABLE[cur.t.id] || []) {
            const v = (own.f || {})[k];
            const f = box.createEl("label", { cls: "lingua-field" });
            const fl2 = f.createSpan({ cls: "lingua-field-label" });
            fl2.createSpan({ cls: "lingua-muted", text: k });
            if (v != null) fl2.createSpan({ cls: "lingua-accent", text: "this card only" });
            lsInput(f, v == null ? "" : v, { cls: "lingua-input" + (v != null ? " is-set" : ""), fkey: "ov:" + cur.key + ":" + k,
                placeholder: base[k] || "(empty)", label: k, dir: "auto",
                onChange: (val) => this.setOv(cur.key, (c) => {
                    const ff = Object.assign({}, c.f);
                    if (val === "") delete ff[k]; else ff[k] = val;
                    const n = Object.assign({}, c, { f: ff });
                    if (!Object.keys(ff).length) delete n.f;
                    return n;
                }) });
        }
        const others = all.filter((c) => c.w === cur.w).length - 1;
        box.createDiv({ cls: "lingua-muted lingua-small", text: "Leave a field empty to use the word’s value. Edits here change only this card — not the word, "
            + `the other ${others} card${others === 1 ? "" : "s"} made from it, or the batch.` });
    }

    /* ================= Card Studio ================= */

    screenStudio(el) {
        const u = this.ui;
        const b = this.batch();
        const wrap = el.createDiv({ cls: "lingua-split" });
        const main = wrap.createDiv({ cls: "lingua-split-main", attr: { "data-scroll": "studio" } });
        const head = main.createDiv({ cls: "lingua-page-head lingua-page-head-row" });
        const ht = head.createDiv();
        ht.createDiv({ cls: "lingua-h1", text: "Card Studio" });
        ht.createDiv({ cls: "lingua-sub", text: `${V4_CATALOG.length} card types · ${V4_CATALOG.reduce((n, c) => n + c.tpls.length, 0)} templates · one style and settings system` });
        this.segmented(head, "studio", [["catalog", "Catalog"], ["library", "Template library"]]);

        if (this.sub.studio === "library") {
            this.render_studio(main.createDiv({ cls: "lingua-legacy" }));
            return;
        }
        const tools = main.createDiv({ cls: "lingua-row lingua-row-wrap" });
        const pills = tools.createDiv({ cls: "lingua-pills" });
        [["all", "All", V4_CATALOG.length], ...V4_CATALOG_GROUPS.map(([g, label]) => [g, label, V4_CATALOG.filter((c) => c.grp === g).length])]
            .forEach(([id, label, n]) => lsPill(pills, label, n, u.catF === id, false, () => { u.catF = id; this.render(); }));
        lsInput(tools, u.catQ, { cls: "lingua-input lingua-search push-right", fkey: "cat-q", placeholder: "Search card types", label: "Search card types",
            onInput: (v) => { u.catQ = v; this.scheduleRender(); } });

        const q = u.catQ.trim().toLowerCase();
        const inBatch = (c) => !!(b && c.wt && (b.outs || []).some((o) => o.type === c.wt));
        const list = V4_CATALOG.filter((c) => (u.catF === "all" || c.grp === u.catF)
            && (!q || (c.name + " " + c.desc + " " + c.tpls.join(" ")).toLowerCase().includes(q)));
        for (const [g, label, sub] of V4_CATALOG_GROUPS) {
            const items = list.filter((c) => c.grp === g);
            if (!items.length) continue;
            const sec = main.createDiv({ cls: "lingua-section" });
            const sh = sec.createDiv({ cls: "lingua-section-head" });
            lsKicker(sh, label);
            sh.createSpan({ cls: "lingua-muted", text: sub });
            const grid = sec.createDiv({ cls: "lingua-cat-grid" });
            for (const c of items) {
                const card = grid.createEl("button", { cls: "lingua-cat" + (u.catSel === c.name ? " is-on" : "") });
                const top = card.createDiv({ cls: "lingua-cat-top" });
                top.createSpan({ cls: "lingua-glyph", text: c.glyph });
                top.createSpan({ cls: "lingua-cat-name", text: c.name });
                if (inBatch(c)) top.createSpan({ cls: "lingua-ok lingua-small", text: "in batch" });
                card.createDiv({ cls: "lingua-muted lingua-cat-desc", text: c.desc });
                const chips = card.createDiv({ cls: "lingua-chips" });
                chips.createSpan({ cls: "lingua-chip", text: c.tpls.length + (c.tpls.length === 1 ? " template" : " templates") });
                chips.createSpan({ cls: "lingua-chip", text: /rate(s)? (themselves|itself)|set(s)? the grade/i.test(c.grade) ? "auto-rates" : "you rate" });
                card.addEventListener("click", () => { u.catSel = c.name; this.render(); });
            }
        }
        if (!list.length) main.createDiv({ cls: "lingua-sheet-empty", text: "No card type matches." });

        const c = V4_CATALOG.find((x) => x.name === u.catSel) || V4_CATALOG[0];
        const aside = wrap.createDiv({ cls: "lingua-aside lingua-aside-wide", attr: { "data-scroll": "studio-aside" } });
        const ah = aside.createDiv({ cls: "lingua-cat-head" });
        ah.createSpan({ cls: "lingua-glyph is-big", text: c.glyph });
        const an = ah.createDiv();
        an.createDiv({ cls: "lingua-h2", text: c.name });
        an.createDiv({ cls: "lingua-muted lingua-mono", text: c.dir });
        aside.createDiv({ cls: "lingua-body-text", text: c.desc });
        lsKicker(aside, "Templates");
        c.tpls.forEach((t, i) => {
            const m = t.split(" · ");
            const r = aside.createDiv({ cls: "lingua-tplrow" });
            r.createSpan({ cls: "lingua-accent", text: String(i + 1) });
            const tx = r.createDiv();
            tx.createDiv({ text: m[0] });
            tx.createDiv({ cls: "lingua-muted lingua-small", text: m.slice(1).join(" · ") || "Always made" });
        });
        lsKicker(aside, "Fields");
        const fs = aside.createDiv({ cls: "lingua-chips" });
        for (const f of c.fields) {
            const req = f.endsWith("*");
            fs.createSpan({ cls: "lingua-chip lingua-mono" + (req ? " is-req" : ""), text: f.replace("*", "") });
        }
        aside.createDiv({ cls: "lingua-muted lingua-small", text: "Outlined in the accent colour: needed for the card to be made." });
        lsKicker(aside, "Grading");
        aside.createDiv({ cls: "lingua-body-text", text: c.grade });
        lsKicker(aside, "Built from");
        aside.createDiv({ cls: "lingua-body-text", text: { words: "A word batch. Fields are mapped from the word list.",
            sets: "A word batch, grouped several per note, or a set you write.",
            sentences: c.wt ? "Sentences — in a word batch, each word becomes one." : "Sentences you write or import in its builder.",
            planned: "The engine, once it is built." }[c.grp] });
        const acts = aside.createDiv({ cls: "lingua-row lingua-row-wrap lingua-aside-actions" });
        const wt = c.wt && v4Wt(c.wt);
        if (wt && b) {
            if (inBatch(c)) {
                lsButton(acts, "Open in " + b.name, "", () => this.go({ screen: "batch", batch: b.id, tab: "types" }));
            } else if (v4TypeAvailable(c.wt, b.lang || this.lang.vault)) {
                lsButton(acts, "Add to " + b.name, "cta", async () => {
                    await this.addOut(b, c.wt);
                    new obsidian.Notice(c.name + " added to " + b.name);
                });
            } else {
                acts.createDiv({ cls: "lingua-muted lingua-small", text: `${c.name} isn't made for ${this.lang.name} batches.` });
            }
        } else if (wt && !b) {
            lsButton(acts, "New word batch", "cta", () => this.plugin.openNewBatch());
        }
        if (c.builder && specFor(c.builder)) {
            lsButton(acts, "Open the " + specFor(c.builder).title + " builder →", wt ? "" : "cta",
                () => this.go({ screen: "builders", builderType: c.builder }));
        }
    }

    /* ================= Inbox ================= */

    screenInbox(el) {
        const u = this.ui;
        const entries = this.plugin.pendingFor(this.lang.vault);
        u.inboxSel = u.inboxSel.filter((i) => i < entries.length);
        const wrap = el.createDiv({ cls: "lingua-split lingua-split-list" });
        const list = wrap.createDiv({ cls: "lingua-split-list-col" });
        const head = list.createDiv({ cls: "lingua-page-head" });
        head.createDiv({ cls: "lingua-h1", text: "Inbox" });
        head.createDiv({ cls: "lingua-sub", text: "Words captured from your notes, not in a batch yet" });
        lsInput(list.createDiv({ cls: "lingua-pad" }), u.inboxQ, {
            cls: "lingua-input lingua-input-lg", fkey: "inbox-q", label: "Capture a word",
            placeholder: "Capture a word or phrase, Enter to save", dir: "auto",
            onInput: (v) => { u.inboxQ = v; },
            onEnter: async (v) => {
                const words = v.split(/\n/).map((x) => x.trim()).filter(Boolean);
                if (!words.length) return;
                for (const term of words) {
                    await this.plugin.addPending(this.lang.vault, { term, reading: "", gloss: "", rhythm: "", ts: Date.now(), source: "Typed" });
                }
                u.inboxQ = "";
                this.render();
                this.plugin.refreshNav();
            },
        });
        const rows = list.createDiv({ cls: "lingua-list", attr: { "data-scroll": "inbox" } });
        entries.forEach((e, i) => {
            const on = u.inboxSel.includes(i);
            const r = rows.createEl("button", { cls: "lingua-list-row" + (on ? " is-sel" : "") });
            lsCheck(r, on);
            const tx = r.createDiv({ cls: "lingua-list-text" });
            const meta = tx.createDiv({ cls: "lingua-list-meta" });
            meta.createSpan({ text: e.source || "Captured" });
            meta.createSpan({ text: v4Ago(e.ts) });
            tx.createDiv({ cls: "lingua-list-term", text: e.term, attr: { dir: "auto" } });
            if (e.reading || e.gloss) tx.createDiv({ cls: "lingua-muted", text: [e.reading, e.gloss].filter(Boolean).join(" · ") });
            r.addEventListener("click", () => { u.inboxSel = on ? u.inboxSel.filter((x) => x !== i) : [...u.inboxSel, i]; this.render(); });
        });
        if (!entries.length) rows.createDiv({ cls: "lingua-sheet-empty", text: "Inbox is empty." });

        const side = wrap.createDiv({ cls: "lingua-split-detail" });
        const inner = side.createDiv({ cls: "lingua-detail-inner" });
        const n = u.inboxSel.length;
        inner.createDiv({ cls: "lingua-h2", text: n ? n + " selected" : entries.length ? "Select words to move" : "Nothing waiting" });
        if (entries.length) {
            const pick = inner.createDiv({ cls: "lingua-row" });
            lsButton(pick, n === entries.length ? "Select none" : "Select all", "small", () => {
                u.inboxSel = n === entries.length ? [] : entries.map((_, i) => i); this.render();
            });
        }
        const batches = this.plugin.v4BatchesFor(this.lang.vault);
        if (!batches.some((x) => x.id === u.inboxTarget)) u.inboxTarget = batches.length ? (this.batch() || batches[0]).id : "__new";
        const tl = inner.createEl("label", { cls: "lingua-field" });
        tl.createSpan({ cls: "lingua-muted", text: "Add to batch" });
        lsSelect(tl, u.inboxTarget, [...batches.map((x) => ({ value: x.id, label: x.name })), { value: "__new", label: "New batch…" }],
            (v) => { u.inboxTarget = v; });
        const acts = inner.createDiv({ cls: "lingua-row lingua-row-wrap" });
        const move = lsButton(acts, "Add and look up", "cta", () => this.inboxMove(u.inboxSel.slice(), u.inboxTarget));
        const dismiss = lsButton(acts, "Dismiss", "", async () => {
            for (const i of u.inboxSel.slice().sort((a, b2) => b2 - a)) await this.plugin.removePending(this.lang.vault, i);
            u.inboxSel = [];
            this.render(); this.plugin.refreshNav();
        });
        if (!n) { move.disabled = true; dismiss.disabled = true; }

        const keep = inner.createDiv({ cls: "lingua-panel lingua-keep" });
        keep.createDiv({ cls: "lingua-strong", text: "Keep in the vault" });
        keep.createDiv({ cls: "lingua-muted lingua-small", text: `Appends the selected words to Vocabulary — ${this.lang.vault}`
            + (this.plugin.settings.createVocabNotes ? " and gives each a vocab note" : "") + ", without making cards." });
        const srcIn = lsInput(keep, "", { fkey: "inbox-src", placeholder: "source (optional) — e.g. 'Boox — Chapter 3'", label: "Source" });
        const save = lsButton(keep, "Save to vault", "", () => this.plugin.withOp("saving vocabulary", async () => {
            const nSaved = await this.plugin.saveToVault(this.lang, srcIn.value, u.inboxSel.slice());
            new obsidian.Notice(`Appended ${nSaved} entr${nSaved === 1 ? "y" : "ies"} to Vocabulary — ${this.lang.vault}.`);
            u.inboxSel = [];
            this.render(); this.plugin.refreshNav();
        }, save));
        if (!n) save.disabled = true;
    }

    /* Inbox -> batch: reading/meaning the capture already had are kept, the
       vocab note's frontmatter (audio / traditional / zhuyin / image) is
       merged in, and the rest is looked up. */
    async inboxMove(indices, target) {
        if (!indices.length) return;
        const entries = this.plugin.pendingFor(this.lang.vault);
        const chosen = indices.map((i) => entries[i]).filter(Boolean).map((e) => Object.assign({}, e));
        this.enrichFromNotes(chosen);
        const zh = this.isMandarin();
        const words = chosen.map((e) => v4MakeWord(e.term, {
            P: zh ? v4PinyinMarks(e.reading || "") : (e.reading || ""), M: e.gloss || "",
            T: e.traditional || "", Z: e.zhuyin || "", image: e.image || "",
            audioFile: e.audio || "", audio: e.audio ? "Saved" : "", src: e.source || "Inbox" }));
        let b = this.plugin.v4Batch(target);
        if (!b) {
            b = await this.plugin.v4Add(v4NewBatch("Inbox · " + new Date().toISOString().slice(0, 10), this.lang.vault, "Inbox"));
        }
        const have = new Set(b.words.map((w) => w.S));
        const fresh = words.filter((w) => !have.has(w.S) && have.add(w.S));
        if (fresh.length < words.length) new obsidian.Notice(`${words.length - fresh.length} already in ${b.name}.`);
        words.length = 0;
        words.push(...fresh);
        await this.plugin.v4Mut(b.id, (x) => ({ words: [...x.words, ...words] }));
        for (const i of indices.slice().sort((a, c) => c - a)) await this.plugin.removePending(this.lang.vault, i);
        this.ui.inboxSel = [];
        await this.go({ screen: "batch", batch: b.id, tab: "words" });
        this.enrichNewWords(b.id, words.map((w) => w.id));
    }

    /* ================= Review ================= */

    screenReview(el) {
        const p = this.page(el, "Review", "One scheduler: reviews happen in Reading Companion, so an interval never diverges between two surfaces.");
        const rc = this.readingCompanion();
        const card = p.createDiv({ cls: "lingua-panel lingua-hero" });
        lsIcon(card.createDiv({ cls: "lingua-hero-icon" }), "clock", 30);
        if (!rc) {
            card.createDiv({ cls: "lingua-h2", text: "Reading Companion isn't enabled" });
            card.createDiv({ cls: "lingua-muted", text: "Enable it to study the cards made here — vocab and the cards authored in batches and builders." });
            return;
        }
        card.createDiv({ cls: "lingua-h2", text: "Study what's due" });
        card.createDiv({ cls: "lingua-muted", text: "Opens the Study view on everything due: derived vocab cards and the cards you author here." });
        lsButton(card.createDiv({ cls: "lingua-row" }), "Study due cards", "cta", () => rc.openStudy());
        const batches = this.plugin.v4BatchesFor(this.lang.vault).filter((x) => x.lastExport);
        if (batches.length) {
            lsKicker(p, "Recently sent to Anki");
            const l = p.createDiv({ cls: "lingua-list-plain" });
            for (const x of batches.sort((a, c) => c.lastExport.at - a.lastExport.at).slice(0, 8)) {
                const r = l.createEl("button", { cls: "lingua-nav-row" });
                lsIcon(r, "book", 20);
                const t = r.createDiv({ cls: "lingua-nav-row-text" });
                t.createDiv({ text: x.name });
                t.createDiv({ cls: "lingua-muted lingua-small", text: (x.lastExport.mode === "push" ? "Pushed " : "Exported ") + x.lastExport.cards + " cards · " + v4Ago(x.lastExport.at) });
                r.addEventListener("click", () => this.go({ screen: "batch", batch: x.id }));
            }
        }
    }

    /* ================= Stats ================= */

    screenStats(el) {
        const p = this.page(el, "Stats", `${this.lang.name} — from the vocabulary record and your batches`);
        const batches = this.plugin.v4BatchesFor(this.lang.vault);
        const sums = batches.map((x) => v4Summary(x));
        lsKicker(p, "Batches");
        const t1 = p.createDiv({ cls: "lingua-tiles" });
        const tile = (parent, icon, n, label, warn) => {
            const t = parent.createDiv({ cls: "lingua-tile" + (warn ? " is-warn" : "") });
            lsIcon(t.createDiv({ cls: "lingua-tile-icon" }), icon, 22);
            t.createDiv({ cls: "lingua-tile-n", text: String(n) });
            t.createDiv({ cls: "lingua-tile-label", text: label });
        };
        tile(t1, "layers", batches.length, batches.length === 1 ? "batch" : "batches");
        tile(t1, "book", sums.reduce((n, x) => n + x.words, 0), "words in batches");
        tile(t1, "check", sums.reduce((n, x) => n + x.live, 0), "cards ready");
        tile(t1, "flame", sums.reduce((n, x) => n + x.needN, 0), "to check", sums.some((x) => x.needN));

        lsKicker(p, "Vocabulary record");
        const t2 = p.createDiv({ cls: "lingua-tiles" });
        if (this.stats === null || this.stats.lang !== this.lang.vault) {
            t2.createDiv({ cls: "lingua-muted", text: "Loading…" });
            this.stats = { lang: this.lang.vault, loading: true };
            this.plugin.withOp("loading stats", async () => {
                try {
                    const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                        `/vocab/rows?lang=${encodeURIComponent(this.lang.vault)}&enrich=0`);
                    this.stats = { lang: this.lang.vault, s: summarizeVocabRows((r && r.rows) || []) };
                } catch (e) {
                    this.stats = { lang: this.lang.vault, error: String(e.message || e) };
                }
                this.render();
            });
            return;
        }
        if (this.stats.loading) { t2.createDiv({ cls: "lingua-muted", text: "Loading…" }); return; }
        if (this.stats.error) { t2.createDiv({ cls: "lingua-error", text: this.stats.error }); return; }
        const s = this.stats.s;
        if (!s.total) { t2.createDiv({ cls: "lingua-muted", text: "No words tracked yet for " + this.lang.name + "." }); return; }
        tile(t2, "book", s.total, "tracked");
        tile(t2, "check", s.known, "known");
        tile(t2, "flame", s.learning, "learning");
        tile(t2, "eye", s.seen, "seen");
        tile(t2, "clock", s.unknown, "unknown");
        tile(t2, "pen", s.productive, "productive");
        p.createDiv({ cls: "lingua-muted lingua-small", text: "The sortable views (unknown by frequency, receptive but not productive, the mining queue) live in the "
            + `Vocabulary — ${this.lang.vault} note.` + (s.ignored ? ` ${s.ignored} ignored.` : "") });
        lsButton(p.createDiv({ cls: "lingua-row" }), "Open the vocabulary note", "",
            () => this.plugin.openNote(`01 Notes/linguistics/Vocabulary — ${this.lang.vault}.md`));
    }

    /* ================= Manage ================= */

    screenManage(el) {
        const p = this.page(el, "Manage", "Languages, voices and how the workspace reaches its engines");
        this.segmented(p, "manage", [["languages", "Languages"], ["voices", "Voices"], ["settings", "Settings"]]);
        const body = p.createDiv({ cls: "lingua-legacy" });
        if (this.sub.manage === "voices") this.render_tts(body);
        else if (this.sub.manage === "settings") this.render_settings(body);
        else this.render_manage(body);
    }

    /* ================= Stacks ================= */

    screenStack(el) {
        const stacks = this.plugin.v4Stacks();
        const st = this.plugin.v4Stack(this.stackId) || stacks[0];
        if (!st) {
            const p = this.page(el, "Stacks", "Batches in study order — one deck with a numbered subdeck per batch.");
            const card = p.createDiv({ cls: "lingua-panel lingua-empty-hero" });
            card.createDiv({ cls: "lingua-muted", text: "No stacks yet." });
            lsButton(card.createDiv({ cls: "lingua-row" }), "New stack", "cta", async () => {
                const ns = await this.plugin.v4AddStack("New stack", []);
                this.go({ screen: "stack", stack: ns.id });
            });
            return;
        }
        this.stackId = st.id;
        const all = this.plugin.v4Store().batches;
        const { root, steps } = v4StackSteps(st, all, this.plugin.settings.deckPrefix);
        const wrap = el.createDiv({ cls: "lingua-split lingua-split-list" });
        const left = wrap.createDiv({ cls: "lingua-split-list-col" });
        const head = left.createDiv({ cls: "lingua-page-head" });
        lsInput(head, st.name, { cls: "lingua-title-input", fkey: "stack-name", label: "Stack name",
            onChange: (v) => { if (v.trim()) this.plugin.v4MutStack(st.id, () => ({ name: v.trim() })).then(() => { this.render(); this.plugin.refreshNav(); }); } });
        head.createDiv({ cls: "lingua-sub", text: "Batches in study order. Each becomes a numbered subdeck." });
        const list = left.createDiv({ cls: "lingua-list", attr: { "data-scroll": "stack-" + st.id } });
        const setSteps = (fn) => this.plugin.v4MutStack(st.id, (x) => ({ steps: fn((x.steps || []).filter((id) => all.some((b) => b.id === id))) }))
            .then(() => { this.render(); this.plugin.refreshNav(); });
        steps.forEach((s, i) => {
            const r = list.createDiv({ cls: "lingua-step" });
            r.createSpan({ cls: "lingua-step-n", text: String(s.n) });
            const t = r.createDiv({ cls: "lingua-step-text" });
            t.createDiv({ cls: "lingua-h3", text: s.batch.name });
            const sum = v4Summary(s.batch);
            t.createDiv({ cls: "lingua-muted", text: `${langByVault(s.batch.lang || "zh").name} · ${sum.words} words · ${sum.types} card types · ${sum.live} cards` });
            const ctl = r.createDiv({ cls: "lingua-step-ctl" });
            const up = lsIconButton(ctl, "arrowUp", "Move up", () => setSteps((ids) => { const j = ids.indexOf(s.batch.id); if (j > 0) [ids[j - 1], ids[j]] = [ids[j], ids[j - 1]]; return ids; }), 18);
            const dn = lsIconButton(ctl, "arrowDown", "Move down", () => setSteps((ids) => { const j = ids.indexOf(s.batch.id); if (j >= 0 && j < ids.length - 1) [ids[j + 1], ids[j]] = [ids[j], ids[j + 1]]; return ids; }), 18);
            lsIconButton(ctl, "x", "Remove from stack", () => setSteps((ids) => ids.filter((id) => id !== s.batch.id)), 18);
            if (i === 0) up.disabled = true;
            if (i === steps.length - 1) dn.disabled = true;
        });
        const addable = all.filter((b) => !(st.steps || []).includes(b.id));
        const ad = list.createDiv({ cls: "lingua-step-add" });
        ad.createDiv({ cls: "lingua-faint", text: addable.length ? "Add a batch" : steps.length ? "Every batch is in this stack." : "Make a batch first." });
        for (const b of addable) {
            const btn = ad.createEl("button", { cls: "lingua-dashed" });
            lsIcon(btn, "plus", 16);
            btn.createSpan({ cls: "lingua-grow", text: b.name });
            btn.createSpan({ cls: "lingua-muted", text: v4Summary(b).live + " cards" });
            btn.addEventListener("click", () => setSteps((ids) => [...ids, b.id]));
        }

        const right = wrap.createDiv({ cls: "lingua-split-detail" });
        const inner = right.createDiv({ cls: "lingua-detail-inner" });
        inner.createDiv({ cls: "lingua-h2", text: "Deck that will be made" });
        const tree = inner.createDiv({ cls: "lingua-panel lingua-tree" });
        tree.createDiv({ cls: "lingua-strong", text: root });
        for (const s of steps) {
            const r = tree.createDiv({ cls: "lingua-tree-row" });
            r.createSpan({ text: s.deck.slice(root.length + 2) });
            r.createSpan({ cls: "lingua-muted", text: s.cards + " cards" });
        }
        if (!steps.length) tree.createDiv({ cls: "lingua-muted", text: "Add batches on the left." });
        const acts = inner.createDiv({ cls: "lingua-row lingua-row-wrap" });
        lsButton(acts, "Export stack .apkg", "", (e, btn) => this.exportStack(st.id, "export", btn));
        lsButton(acts, "Push to Anki", "cta", (e, btn) => this.exportStack(st.id, "push", btn));
        lsButton(inner.createDiv({ cls: "lingua-row" }), "Delete stack…", "danger small", async () => {
            if (!(await lsConfirm(this.app, "Delete stack", `Delete “${st.name}”? Its batches stay.`, "Delete"))) return;
            await this.plugin.v4RemoveStack(st.id);
            this.stackId = null;
            this.render(); this.plugin.refreshNav();
        });
    }

    /* ================= the tool screens (classic) ================= */

    screenDictionary(el) {
        this.render_dictionary(this.page(el, "Dictionary", `Search the ${this.lang.name} dictionary — add a hit to the open batch or the Inbox.`));
    }

    screenSentences(el) {
        const p = this.page(el, "Sentences", "Example sentences from the installed corpus, and one-off cloze sentences from the local model.");
        this.render_sentences(p);
        lsKicker(p.createDiv({ cls: "lingua-gap" }), "Generate a cloze");
        this.render_cloze(p);
    }

    screenBuilders(el) {
        const spec = this.builderType && specFor(this.builderType);
        const p = this.page(el, "Builders", spec ? ""
            : "Every classic builder — sentence, dialogue, cloze and grammar cards, written row by row.");
        if (!spec) this.segmented(p, "builders", [["builders", "Builders"], ["stack", "Stack builder batches"]]);
        const body = p.createDiv({ cls: "lingua-legacy" });
        if (!spec && this.sub.builders === "stack") this.render_stack(body);
        else this.render_builders(body);
    }

    screenTools(el) {
        this.render_tools(this.page(el, "Import & OCR", "Bring words in from a list, a photo or a recording; find pictures for visual cards."));
    }

    /* ================= actions ================= */

    /* New words into a batch: added at once, then filled — reading and
       meaning from the dictionary, an example from the sentence corpus,
       and audio — word by word, the table updating as each lands. The
       terms are also upserted into the shared vocabulary record (merge,
       never duplicate), as the old Vocab builder did. */
    async addWords(batchId, terms, src) {
        const b = this.plugin.v4Batch(batchId);
        if (!b) return;
        const have = new Set(b.words.map((w) => w.S));
        const fresh = terms.filter((t) => !have.has(t)).map((t) => v4MakeWord(t, { src: src || "Typed" }));
        if (fresh.length < terms.length) new obsidian.Notice(`${terms.length - fresh.length} already in this batch.`);
        if (!fresh.length) { this.render(); return; }
        await this.mut((x) => ({ words: [...x.words, ...fresh] }), batchId);
        const ruled = (b.rules || []).filter((r) => r.on).length;
        new obsidian.Notice(`${fresh.length} added` + (ruled ? " · rules applied" : ""));
        for (const w of fresh) {
            call("vault", this.plugin.settings.vaultSidecarUrl, "/vocab/upsert", { lang: b.lang || this.lang.vault, row: { term: w.S } })
                .catch(() => { /* offline — the batch still has the word */ });
        }
        this.enrichNewWords(batchId, fresh.map((w) => w.id));
    }

    async enrichNewWords(batchId, ids) {
        const b = this.plugin.v4Batch(batchId);
        if (!b) return;
        const need = (pred) => ids.filter((id) => { const w = b.words.find((x) => x.id === id); return w && pred(w); });
        await this.lookupWords(batchId, need((w) => !w.P || (!w.M && !(w.senses || []).length)));
        await this.fillExamples(batchId, ids, { quiet: true });
        await this.resolveAudio(batchId, ids.filter((id) => { const w = (this.plugin.v4Batch(batchId) || b).words.find((x) => x.id === id); return w && !w.audio; }), { quiet: true });
    }

    lookupWords(batchId, ids, opts) {
        const o = opts || {};
        if (!ids.length) return Promise.resolve();
        return this.plugin.withOp(`looking up ${ids.length} word${ids.length === 1 ? "" : "s"}`, async () => {
            let failed = 0, empty = 0;
            for (const id of ids) {
                const b = this.plugin.v4Batch(batchId);
                const w0 = b && b.words.find((x) => x.id === id);
                if (!w0) continue;
                const w = o.force ? Object.assign({}, w0, { P: "", M: "", senses: [], Z: "" }) : w0;
                let r;
                try {
                    r = await call("vault", this.plugin.settings.vaultSidecarUrl, "/translate/word",
                        { word: w.S, src: b.lang || this.lang.vault, tgt: "EN" });
                } catch (e) { failed++; continue; }
                if (!r || !r.provider) { empty++; continue; }
                const patch = v4LookupPatch(w, r, b.lang || this.lang.vault);
                if (o.force) Object.assign(patch, { senses: patch.senses || [] }, patch.M ? {} : { M: "" });
                if (Object.keys(patch).length) await this.mutWords([id], () => patch, batchId);
            }
            const msg = lookupFailureNotice(failed, ids.length);
            if (msg) new obsidian.Notice(msg, 8000);
            if (empty) new obsidian.Notice(`${empty} word${empty === 1 ? "" : "s"} not in any dictionary — fill them by hand, or check the spelling.`);
        });
    }

    /* Examples: the installed sentence corpus first (a real sentence with
       its translation); the local model's cloze sentence when the corpus
       has none. */
    fillExamples(batchId, ids, opts) {
        const b0 = this.plugin.v4Batch(batchId);
        const todo = ids.filter((id) => { const w = b0 && b0.words.find((x) => x.id === id); return w && !w.Sent; });
        if (!todo.length) return Promise.resolve();
        return this.plugin.withOp(`finding ${todo.length} example${todo.length === 1 ? "" : "s"}`, async () => {
            const s = this.plugin.settings;
            let found = 0, engineDown = false;
            for (const id of todo) {
                const b = this.plugin.v4Batch(batchId);
                const w = b && b.words.find((x) => x.id === id);
                if (!w || w.Sent) continue;
                const lingua = langByVault(b.lang || this.lang.vault).lingua;
                let patch = null;
                try {
                    const r = await call("lingua", s.linguaSidecarUrl,
                        `/sentences/lookup?word=${encodeURIComponent(w.S)}&lang=${encodeURIComponent(lingua)}&limit=5`);
                    const hit = ((r && r.sentences) || []).find((x) => sentenceText(x).includes(w.S));
                    if (hit) patch = { Sent: sentenceText(hit), ST: sentenceGloss(hit) };
                    if (!patch) {
                        const c = await call("lingua", s.linguaSidecarUrl, "/ai/cloze",
                            { word: w.S, lang: lingua, context: "", url: s.aiUrl || "", model: s.aiModel || "" });
                        if (c && c.cloze) patch = { Sent: clozeStrip(c.cloze), ST: c.gloss || "" };
                    }
                } catch (e) { engineDown = true; break; }
                if (patch) { found++; await this.mutWords([id], () => patch, batchId); }
            }
            if (engineDown && !(opts && opts.quiet)) new obsidian.Notice(serverDownMessage("lingua", s.linguaSidecarUrl), 8000);
            else if (!(opts && opts.quiet)) new obsidian.Notice(`Examples found for ${found} of ${todo.length}.`);
        });
    }

    /* Audio: the vault sidecar resolves Forvo first, then its own TTS, and
       caches the clip; the word keeps the source label and the filename. */
    resolveAudio(batchId, ids, opts) {
        if (!ids.length) return Promise.resolve();
        return this.plugin.withOp(`finding audio for ${ids.length} word${ids.length === 1 ? "" : "s"}`, async () => {
            let got = 0, failed = 0;
            for (const id of ids) {
                const b = this.plugin.v4Batch(batchId);
                const w = b && b.words.find((x) => x.id === id);
                if (!w) continue;
                try {
                    const r = await call("vault", this.plugin.settings.vaultSidecarUrl, "/vocab/audio",
                        { word: w.S, lang: langByVault(b.lang || this.lang.vault).lingua });
                    if (r && r.ok) {
                        got++;
                        await this.mutWords([id], () => ({ audio: r.source || "TTS", audioFile: r.filename || "" }), batchId);
                    } else failed++;
                } catch (e) { failed++; if (failed === 1 && got === 0 && ids.length > 2) { new obsidian.Notice(String(e.message || e), 8000); break; } }
            }
            if (!(opts && opts.quiet) || failed) new obsidian.Notice(`Audio for ${got} of ${ids.length}` + (failed ? ` — ${failed} had none` : "") + ".");
        });
    }

    /* Traditional from the engine's dictionary; Zhuyin from the pinyin. */
    fillTradZhuyin(batchId, ids) {
        return this.plugin.withOp("filling traditional + zhuyin", async () => {
            let engine = true;
            for (const id of ids) {
                const b = this.plugin.v4Batch(batchId);
                const w = b && b.words.find((x) => x.id === id);
                if (!w) continue;
                const patch = {};
                const z = v4Zhuyin(w.P);
                if (z) patch.Z = z;
                if (engine) {
                    try {
                        const r = await call("lingua", this.plugin.settings.linguaSidecarUrl, "/dict/search",
                            { query: w.S, lang: "cmn", limit: 5, offset: 0, sort: "alpha", hsk_level: 0 });
                        const hit = ((r && r.results) || []).find((x) => x.word === w.S || x.simplified === w.S);
                        const t = hit && (hit.traditional || hit.trad || "");
                        if (t) patch.T = t;
                    } catch (e) { engine = false; new obsidian.Notice("Traditional needs the LinguaStudio engine — Zhuyin is filled from the pinyin.", 8000); }
                }
                if (Object.keys(patch).length) await this.mutWords([id], () => patch, batchId);
            }
        });
    }

    async playWord(b, w) {
        try {
            const r = await call("vault", this.plugin.settings.vaultSidecarUrl, "/vocab/audio",
                { word: w.S, lang: langByVault(b.lang || this.lang.vault).lingua });
            const b64 = ttsAudioB64(r);
            if (!r || !r.ok || !b64) { new obsidian.Notice((r && r.error) || "No audio."); return; }
            if (this.player) this.player.pause();
            this.player = new Audio("data:audio/mpeg;base64," + b64);
            this.player.play().catch(() => {});
            if (!w.audio || (r.filename && r.filename !== w.audioFile)) {
                this.mutWords([w.id], () => ({ audio: r.source || w.audio || "TTS", audioFile: r.filename || w.audioFile || "" }), b.id);
            }
        } catch (e) { new obsidian.Notice(String(e.message || e)); }
    }

    /* ----- export / push ----- */

    /* One batch to Anki. The engine's family route first (themes, flags and
       per-template skips ride along); where it has none, the classic routes
       (v4ExportJobs). Resolves {cards, files, notes}. Throws on a failure
       the operator must see. */
    async runBatchExport(b, mode, deckRoot) {
        const s = this.plugin.settings;
        const lingua = langByVault(b.lang || this.lang.vault).lingua;
        const files = [];
        let cards = 0, classicOnly;
        const fam = v4BatchToFamilyGroups(b, deckRoot);
        if (fam.groups.length) {
            let r = null;
            try {
                r = await callOptional("lingua", s.linguaSidecarUrl, FAMILY_ROUTES[mode],
                    { groups: fam.groups, lang: lingua, filename: sanitizeFilename(b.name) });
            } catch (e) { r = null; /* engine down: the classic vocab export still runs on the vault sidecar */ }
            if (r) {
                if (r.ok === false) throw new Error(r.error || "The engine refused the batch.");
                if (mode === "export" && r.path) files.push(this.plugin.copyApkg(r.path));
                cards += fam.groups.reduce((n, g) => n + g.notes.filter((x) => !x.skip.length).length, 0);
                classicOnly = (b.outs || []).map((o, i) => (V4_WT_TO_FAMILY[o.type] ? -1 : i)).filter((i) => i >= 0);
            }
        }
        const { jobs, notes } = v4ExportJobs(b, deckRoot, classicOnly);
        const shown = classicOnly ? notes.filter((n) => !/Theme choices/.test(n)) : notes;
        for (const job of jobs) {
            let r;
            if (job.kind === "vocab") {
                if (mode === "push") {
                    r = await call("lingua", s.linguaSidecarUrl, "/vocab/push", job.payload);
                } else {
                    const target = vocabExportSidecar(s);
                    r = await call(target.kind, target.base, "/vocab/export",
                        Object.assign({}, job.payload, { filename: sanitizeFilename(b.name + " - " + job.label) }));
                }
            } else {
                r = await call("lingua", s.linguaSidecarUrl, `/${mode}/${job.type}`, job.payload);
            }
            if (!r || r.ok === false) throw new Error(`${job.label}: ` + ((r && r.error) || (mode === "push" ? "push failed — is Anki open?" : "export failed.")));
            if (mode === "export") {
                if (!r.path) throw new Error(`${job.label}: the engine built no file.`);
                files.push(this.plugin.copyApkg(r.path));
            }
            cards += job.cards;
        }
        return { cards, files, notes: shown };
    }

    async markExported(b) {
        try {
            await call("vault", this.plugin.settings.vaultSidecarUrl, "/lingua/anki-exported",
                { language: b.lang || this.lang.vault, terms: b.words.map((w) => w.S) });
        } catch (e) {
            new obsidian.Notice("Cards done, but the vault sidecar is down — the inventory ✓ will catch up when it's back.", 8000);
        }
    }

    exportBatch(batchId, mode, btn) {
        const b = this.plugin.v4Batch(batchId);
        if (!b) return Promise.resolve();
        if (!v4Summary(b).live) { new obsidian.Notice("No cards to " + (mode === "push" ? "push" : "export") + " — add words, or turn a card type on."); return Promise.resolve(); }
        return this.plugin.withOp((mode === "push" ? "pushing " : "exporting ") + b.name, async () => {
            const res = await this.runBatchExport(b, mode);
            await this.markExported(b);
            await this.plugin.v4Mut(b.id, () => ({ lastExport: { mode, at: Date.now(), cards: res.cards } }));
            this.render(); this.plugin.refreshNav();
            new obsidian.Notice(mode === "push"
                ? `Pushed ${res.cards} cards to ${b.deck}.`
                : `Exported ${res.cards} cards → ${this.filesText(res.files)}`, 8000);
            this.noteOnce(res.notes);
        }, btn);
    }

    filesText(files) {
        if (files.length === 1) return files[0];
        const dir = (files[0] || "").replace(/[\\/][^\\/]*$/, "");
        return `${files.length} .apkg files in ${dir}`;
    }

    // What the classic routes can't carry is said once a session, not on
    // every push.
    noteOnce(notes) {
        const seen = this.plugin._saidNotes = this.plugin._saidNotes || new Set();
        const fresh = notes.filter((n) => !seen.has(n));
        fresh.forEach((n) => seen.add(n));
        if (fresh.length) new obsidian.Notice(fresh.join("\n"), 12000);
    }

    exportStack(stackId, mode, btn) {
        const st = this.plugin.v4Stack(stackId);
        if (!st) return Promise.resolve();
        const { steps } = v4StackSteps(st, this.plugin.v4Store().batches, this.plugin.settings.deckPrefix);
        if (!steps.length) { new obsidian.Notice("Add a batch to the stack first."); return Promise.resolve(); }
        return this.plugin.withOp((mode === "push" ? "pushing " : "exporting ") + st.name, async () => {
            let cards = 0;
            const files = [], notes = new Set();
            for (const step of steps) {
                if (!step.cards) continue;
                const r = await this.runBatchExport(step.batch, mode, step.deck);
                cards += r.cards; files.push(...r.files); r.notes.forEach((n) => notes.add(n));
                await this.markExported(step.batch);
                await this.plugin.v4Mut(step.batch.id, () => ({ lastExport: { mode, at: Date.now(), cards: r.cards } }));
            }
            this.render(); this.plugin.refreshNav();
            new obsidian.Notice(mode === "push" ? `Pushed ${cards} cards in ${steps.length} subdecks.`
                : `Exported ${cards} cards → ${this.filesText(files)}`, 8000);
            this.noteOnce([...notes]);
        }, btn);
    }


    /* ================= classic tool screens (unchanged engines) ================= */


    rowTool(parent, icon, label, fn) {
        const b = parent.createEl("button", {
            cls: "lingua-tool", attr: { "aria-label": label, title: label } });
        obsidian.setIcon(b, icon);
        b.addEventListener("click", () => fn(b));
        return b;
    }


    // A real transport (play/pause/seek/volume) for one-off audio played from
    // a row action (vocab pronunciation, dictionary lookup) — a bare
    // `new Audio().play()` has no UI at all, so once it started there was no
    // way to pause it. One player per container: a second click replaces the
    // previous element rather than stacking players underneath each other.
    playWithControls(container, b64) {
        const old = container.querySelector(".lingua-audio-player");
        if (old) old.remove();
        const player = container.createEl("audio", {
            cls: "lingua-audio-player", attr: { controls: true, autoplay: true } });
        player.src = "data:audio/mpeg;base64," + b64;
        return player;
    }


    input(form, label, placeholder) {
        const wrap = form.createDiv({ cls: "lingua-field" });
        wrap.createEl("label", { text: label });
        return wrap.createEl("input", { attr: { type: "text", placeholder } });
    }


    /* ----- Dictionary ----- */

    render_dictionary(el) {
        const bar = el.createDiv({ cls: "lingua-form lingua-dict-bar" });
        const q = el.ownerDocument.createElement("input");
        q.type = "text";
        q.placeholder = "search the dictionary…";
        q.value = this.dict.query;
        bar.appendChild(q);

        let sort = null, hsk = null;
        if (isMandarinLang(this.lang.vault)) {
            sort = bar.createEl("select");
            for (const [v, label] of [["alpha", "a–z"], ["hsk", "HSK"], ["freq", "frequency"]]) {
                sort.createEl("option", { value: v, text: label });
            }
            hsk = bar.createEl("select");
            hsk.createEl("option", { value: "0", text: "all HSK" });
            for (let i = 1; i <= 7; i++) {
                hsk.createEl("option", { value: String(i), text: i === 7 ? "HSK 7–9" : `HSK ${i}` });
            }
        }

        const go = bar.createEl("button", { text: "Search", cls: "mod-cta" });
        const search = async (offset) => {
            this.dict.busy = true;
            this.dict.query = q.value;
            try {
                const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                    "/dict/search", {
                        query: q.value.trim(), lang: this.lang.lingua,
                        limit: 50, offset: offset || 0,
                        sort: sort ? sort.value : "alpha",
                        hsk_level: hsk ? parseInt(hsk.value, 10) : 0,
                    });
                if (r && r.ok) {
                    this.dict.results = (offset ? this.dict.results : []).concat(r.results || []);
                    this.dict.total = r.total || this.dict.results.length;
                    this.dict.offset = (offset || 0) + (r.results || []).length;
                } else {
                    new obsidian.Notice((r && r.error) || "Search failed.");
                }
            } catch (e) {
                new obsidian.Notice(String(e.message || e));
            } finally {
                this.dict.busy = false;
                this.render();
            }
        };
        go.addEventListener("click", () => search(0));
        q.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); search(0); }
        });

        const zone = el.createDiv({ cls: "lingua-dict-results" });
        if (!this.dict.results.length) {
            zone.createDiv({ cls: "lingua-empty",
                text: this.dict.busy ? "Searching…"
                    : "Search results land here. + adds a word to the open batch; the inbox button keeps it in the Inbox." });
            return;
        }
        const table = zone.createEl("table", { cls: "lingua-table" });
        const thead = table.createEl("thead").createEl("tr");
        const cols = ["word", "reading", "meaning"];
        if (isMandarinLang(this.lang.vault)) cols.push("hsk");
        cols.push("");
        for (const h of cols) thead.createEl("th", { text: h });
        const tbody = table.createEl("tbody");
        for (const r of this.dict.results) {
            const tr = tbody.createEl("tr");
            tr.createEl("td", { text: r.word || "", cls: "lingua-term" });
            tr.createEl("td", { text: r.trans || "" });
            tr.createEl("td", { text: r.meaning || "" });
            if (isMandarinLang(this.lang.vault)) tr.createEl("td", { text: r.hsk ? String(r.hsk) : "" });
            const tools = tr.createEl("td", { cls: "lingua-row-tools" });
            const open = this.batch();
            if (open) {
                this.rowTool(tools, "plus", `Add to ${open.name}`, async () => {
                    const zh = this.isMandarin();
                    const P = zh ? v4PinyinMarks(r.trans || "") : (r.trans || "");
                    const w = v4MakeWord(r.word || "", Object.assign({ P, src: "Dictionary" },
                        v4MeaningFromSenses(v4ParseGloss(r.meaning || "").senses), zh && P ? { Z: v4Zhuyin(P) } : {}));
                    if (!w.S || open.words.some((x) => x.S === w.S)) { new obsidian.Notice(`${r.word} is already in ${open.name}.`); return; }
                    await this.plugin.v4Mut(open.id, (x) => ({ words: [...x.words, w] }));
                    this.plugin.refreshNav();
                    new obsidian.Notice(`${r.word} → ${open.name}`);
                    this.resolveAudio(open.id, [w.id], { quiet: true });
                });
            }
            this.rowTool(tools, "inbox", "Keep in the Inbox", async () => {
                await this.plugin.addPending(this.lang.vault, {
                    term: r.word || "", reading: r.trans || "", gloss: r.meaning || "", rhythm: "",
                    ts: Date.now(), source: "Dictionary",
                });
                this.plugin.refreshNav();
                new obsidian.Notice(`${r.word} → Inbox`);
            });
        }
        if (this.dict.offset < this.dict.total) {
            const more = zone.createEl("button", {
                text: `More (${this.dict.offset}/${this.dict.total})`, cls: "lingua-more" });
            more.addEventListener("click", () => search(this.dict.offset));
        }
    }


    /* ----- Cloze ----- */

    render_cloze(el) {
        const form = el.createDiv({ cls: "lingua-form" });
        const word = this.input(form, "Word / phrase", "the term to cloze");
        word.value = this.cloze.word || "";
        const ctxWrap = form.createDiv({ cls: "lingua-field lingua-field-wide" });
        ctxWrap.createEl("label", { text: "Context (optional)" });
        const ctx = ctxWrap.createEl("textarea", {
            attr: { rows: 2, placeholder: "a sentence or situation to build around" } });
        ctx.value = this.cloze.context || "";

        const row = form.createDiv({ cls: "lingua-actions" });
        const gen = row.createEl("button", { text: "Generate", cls: "mod-cta" });
        gen.addEventListener("click", async () => {
            const w = word.value.trim();
            if (!w) return;
            gen.disabled = true;
            this.cloze.word = w;
            this.cloze.context = ctx.value;
            try {
                this.cloze.result = await call("lingua",
                    this.plugin.settings.linguaSidecarUrl, "/ai/cloze",
                    { word: w, lang: this.lang.lingua, context: ctx.value.trim(),
                        url: this.plugin.settings.aiUrl || "",
                        model: this.plugin.settings.aiModel || "" });
            } catch (e) {
                this.cloze.result = { ok: false, error: String(e.message || e) };
            } finally {
                gen.disabled = false;
                this.render();
            }
        });

        const r = this.cloze.result;
        if (!r) {
            el.createDiv({ cls: "lingua-empty",
                text: "Generates one cloze sentence with the local model. Falls back "
                    + "to a bare cloze when no model is up. For hand-built cloze "
                    + "batches, use Builders → Cloze." });
            return;
        }
        const out = el.createDiv({ cls: "lingua-cloze-result" });
        if (!r.ok && r.error) {
            out.createDiv({ cls: "lingua-error", text: r.error });
            return;
        }
        out.createEl("p", { cls: "lingua-cloze-text", text: r.cloze || "" });
        if (r.gloss) out.createEl("p", { cls: "lingua-cloze-gloss", text: r.gloss });
        out.createEl("p", { cls: "lingua-hint",
            text: (r.model ? `model: ${r.model}` : "") + (r.fallback ? " (fallback)" : "") });
        const acts = out.createDiv({ cls: "lingua-actions" });
        const copy = acts.createEl("button", { text: "Copy" });
        copy.addEventListener("click", () => {
            navigator.clipboard.writeText(r.cloze || "");
            new obsidian.Notice("Copied.");
        });
        const toBatch = acts.createEl("button", { text: "Add to Custom Cloze batch" });
        toBatch.addEventListener("click", async () => {
            await this.plugin.addBatchRow("custom_cloze",
                { cloze: r.cloze || "", gloss: r.gloss || "" });
            new obsidian.Notice("→ Builders → Cloze");
        });
        const toList = acts.createEl("button", { text: "Keep the word in the Inbox" });
        toList.addEventListener("click", async () => {
            await this.plugin.addPending(this.lang.vault, {
                term: this.cloze.word, reading: "",
                gloss: clozeStrip(r.cloze) + (r.gloss ? ` — ${r.gloss}` : ""), rhythm: "",
                ts: Date.now(), source: "Cloze",
            });
            this.plugin.refreshNav();
            new obsidian.Notice(`${this.cloze.word} → Inbox`);
        });
    }


    /* ----- Builders: every card type ----- */

    render_builders(el) {
        if (this.builderType && specFor(this.builderType)) {
            this.renderBuilder(el, this.builderType);
            return;
        }
        el.createDiv({ cls: "lingua-lede",
            text: "Every builder from the app, in the same groups and the same "
                + "forms. Batches are saved as you type and survive restarts; "
                + "export builds an .apkg, push sends straight to Anki." });
        for (const group of CARD_REGISTRY.groups) {
            // The app gates some tools per language (rhythm, chengyu, …) —
            // mirror that: a tool the active language can't use isn't shown.
            const types = group.types.filter((t) => {
                const spec = specFor(t);
                return spec && (!spec.langs || spec.langs.includes(this.lang.lingua));
            });
            if (!types.length) continue;
            const sec = el.createDiv({ cls: "lingua-group" });
            const head = sec.createDiv({ cls: "lingua-group-head" });
            const ic = head.createSpan({ cls: "lingua-group-icon" });
            obsidian.setIcon(ic, GROUP_ICONS[group.name] || "layers");
            head.createSpan({ cls: "lingua-group-name", text: group.name });
            const grid = sec.createDiv({ cls: "lingua-tool-grid" });
            for (const type of types) {
                const spec = specFor(type);
                const rows = this.plugin.batchFor(type).rows.length;
                const card = grid.createDiv({ cls: "lingua-tool-card" });
                card.createDiv({ cls: "lingua-tool-title", text: spec.title });
                card.createDiv({ cls: "lingua-tool-desc", text: spec.description || "" });
                if (rows) card.createDiv({ cls: "lingua-tool-count", text: `${rows} in batch` });
                card.addEventListener("click", () => this.setSection("builders", type));
            }
        }
    }


    renderBuilder(el, type) {
        const spec = specFor(type);
        const batch = this.plugin.batchFor(type);

        const top = el.createDiv({ cls: "lingua-builder-top" });
        const back = top.createEl("button", { cls: "lingua-back", text: "← All builders" });
        back.addEventListener("click", () => this.setSection("builders", null));
        const th = top.createDiv({ cls: "lingua-builder-title" });
        th.createEl("h2", { text: spec.title });
        if (spec.description) th.createDiv({ cls: "lingua-hint", text: spec.description });

        if (spec.custom === "cascade") {
            this.renderCascade(el, spec, batch);
            return;
        }

        const deckRow = el.createDiv({ cls: "lingua-form" });
        const deckWrap = deckRow.createDiv({ cls: "lingua-field" });
        deckWrap.createEl("label", { text: "Deck" });
        const deck = deckWrap.createEl("input", {
            attr: { type: "text", placeholder: spec.deck || "Studio" } });
        deck.value = batch.deck || spec.deck || "";
        deck.addEventListener("change", () => this.plugin.setBatchDeck(type, deck.value));

        // --- add-row form, generated from the spec ---
        const form = el.createDiv({ cls: "lingua-form lingua-builder-form" });
        const inputs = {};
        for (const f of spec.fields) {
            const wrap = form.createDiv({
                cls: "lingua-field" + (f.multiline ? " lingua-field-wide" : "") });
            wrap.createEl("label", { text: f.label || f.key });
            if (f.type === "select") {
                const sel = wrap.createEl("select");
                for (const o of f.options || []) {
                    sel.createEl("option", { value: String(o.value), text: o.label || String(o.value) });
                }
                if (f.default != null) sel.value = String(f.default);
                inputs[f.key] = sel;
            } else if (f.multiline) {
                inputs[f.key] = wrap.createEl("textarea", {
                    attr: { rows: 3, placeholder: f.placeholder || "" } });
            } else {
                inputs[f.key] = wrap.createEl("input", {
                    attr: { type: "text", placeholder: f.placeholder || "" } });
            }
        }
        const addRow = el.createDiv({ cls: "lingua-actions" });
        const primary = spec.primary || spec.fields[0].key;
        const add = async () => {
            const row = {};
            for (const f of spec.fields) row[f.key] = inputs[f.key].value;
            if (!String(row[primary] || "").trim()) {
                new obsidian.Notice(`${spec.fields.find((x) => x.key === primary).label
                    || primary} is required.`);
                return;
            }
            await this.plugin.addBatchRow(type, row);
            for (const f of spec.fields) {
                inputs[f.key].value = f.default != null ? String(f.default)
                    : (f.type === "select" ? inputs[f.key].value : "");
            }
            inputs[primary].focus && inputs[primary].focus();
            this.render();
        };
        addRow.createEl("button", { text: "Add card", cls: "mod-cta" })
            .addEventListener("click", add);
        for (const f of spec.fields) {
            if (!f.multiline && f.type !== "select") {
                inputs[f.key].addEventListener("keydown", (ev) => {
                    if (ev.key === "Enter") { ev.preventDefault(); add(); }
                });
            }
        }

        // --- the batch ---
        const box = el.createDiv({ cls: "lingua-pending" });
        box.createEl("h3", { text: `Batch — ${batch.rows.length}` });
        if (!batch.rows.length) {
            box.createDiv({ cls: "lingua-empty", text: "No cards yet." });
        } else {
            const columns = (spec.columns && spec.columns.length)
                ? spec.columns : spec.fields.slice(0, 3);
            const table = box.createEl("table", { cls: "lingua-table" });
            const thead = table.createEl("thead").createEl("tr");
            for (const c of columns) thead.createEl("th", { text: c.label || c.key });
            thead.createEl("th", { text: "" });
            const tbody = table.createEl("tbody");
            batch.rows.forEach((row, i) => {
                const tr = tbody.createEl("tr");
                columns.forEach((c, ci) => {
                    const raw = String(row[c.key] || "");
                    tr.createEl("td", { text: raw.length > 80 ? raw.slice(0, 77) + "…" : raw,
                        cls: ci === 0 ? "lingua-term" : "" });
                });
                const tools = tr.createEl("td", { cls: "lingua-row-tools" });
                this.rowTool(tools, "x", "Remove", async () => {
                    await this.plugin.removeBatchRow(type, i);
                    this.render();
                });
            });
        }

        const acts = el.createDiv({ cls: "lingua-actions lingua-anki-actions" });
        const deckName = () => deck.value.trim() || spec.deck || "Studio";
        const run = (label, fn, btn) => this.plugin.withOp(label, fn, btn);

        const preview = acts.createEl("button", { text: "Preview in Anki" });
        preview.addEventListener("click", () => run(`previewing ${spec.title}`, async () => {
            if (!batch.rows.length) throw new Error("Nothing to preview.");
            const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                `/preview/${type}`, { batch: batchPayload(batch.rows).slice(0, 1) });
            if (!r || r.ok === false) {
                throw new Error((r && r.error) || "Preview failed — is Anki open?");
            }
            new obsidian.Notice("First card is in Anki's preview deck.");
        }, preview));

        const push = acts.createEl("button", { text: "Push to Anki", cls: "mod-cta" });
        push.addEventListener("click", () => run(`pushing ${spec.title}`, async () => {
            if (!batch.rows.length) throw new Error("Nothing to push.");
            const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                `/push/${type}`, { batch: batchPayload(batch.rows),
                    deck_name: deckName(), lang: this.lang.lingua });
            if (!r || r.ok === false) {
                throw new Error((r && r.error) || "Push failed — is Anki open?");
            }
            new obsidian.Notice(`Pushed ${batch.rows.length} card(s) to ${deckName()}.`);
        }, push));

        const exp = acts.createEl("button", { text: "Export .apkg" });
        exp.addEventListener("click", () => run(`exporting ${spec.title}`, async () => {
            if (!batch.rows.length) throw new Error("Nothing to export.");
            const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                `/export/${type}`, { batch: batchPayload(batch.rows),
                    deck_name: deckName(), lang: this.lang.lingua });
            if (!r || r.ok === false || !r.path) {
                throw new Error((r && r.error) || "Export failed.");
            }
            const dest = this.plugin.copyApkg(r.path);
            new obsidian.Notice(`Exported ${batch.rows.length} card(s) → ${dest}`, 8000);
        }, exp));

        const clear = acts.createEl("button", { text: "Clear batch" });
        clear.addEventListener("click", async () => {
            await this.plugin.clearBatch(type);
            this.render();
        });
    }


    /* ----- Card Studio ----- */

    render_studio(el) {
        el.createDiv({ cls: "lingua-lede",
            text: "The engine's Anki templates: fields, front/back HTML and styling. "
                + "Compose a one-off card against any model and push or export it." });

        const bar = el.createDiv({ cls: "lingua-form" });
        const loadBtn = bar.createEl("button", {
            text: this.studio.models ? "Reload models" : "Load models", cls: "mod-cta" });
        loadBtn.addEventListener("click", () => this.plugin.withOp("loading models",
            async () => {
                const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                    "/cardstudio/models");
                if (!r || r.ok === false) throw new Error((r && r.error) || "No models.");
                this.studio.models = r.models || [];
                this.render();
            }, loadBtn));

        if (!this.studio.models) {
            el.createDiv({ cls: "lingua-empty",
                text: "Load models to browse the template library." });
            return;
        }

        const sel = bar.createEl("select");
        sel.createEl("option", { value: "", text: "— pick a card type —" });
        for (const m of this.studio.models) {
            const ct = m.card_type || m.cardType || m.type || String(m);
            sel.createEl("option", { value: ct,
                text: (m.model_name ? `${ct} — ${m.model_name}` : ct) });
        }
        if (this.studio.sel) sel.value = this.studio.sel;
        sel.addEventListener("change", () => this.plugin.withOp("loading template",
            async () => {
                this.studio.sel = sel.value;
                this.studio.template = null;
                this.studio.draft = {};
                if (sel.value) {
                    const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                        `/cardstudio/template/${sel.value}`);
                    if (!r || r.ok === false) throw new Error((r && r.error) || "No template.");
                    this.studio.template = r;
                }
                this.render();
            }));

        const t = this.studio.template;
        if (!t) return;

        const fields = t.fields || [];
        const compose = el.createDiv({ cls: "lingua-pending" });
        compose.createEl("h3", { text: `Compose — ${this.studio.sel}` });
        const form = compose.createDiv({ cls: "lingua-form" });
        const inputs = {};
        for (const f of fields) {
            const name = typeof f === "string" ? f : f.name;
            const wrap = form.createDiv({ cls: "lingua-field" });
            wrap.createEl("label", { text: name });
            inputs[name] = wrap.createEl("input", { attr: { type: "text",
                placeholder: (t.sample && t.sample[name]) || "" } });
            if (this.studio.draft[name]) inputs[name].value = this.studio.draft[name];
            inputs[name].addEventListener("input", () => {
                this.studio.draft[name] = inputs[name].value;
            });
        }
        const acts = compose.createDiv({ cls: "lingua-actions" });
        const grab = () => {
            const out = {};
            for (const k of Object.keys(inputs)) out[k] = inputs[k].value;
            return out;
        };
        const pushB = acts.createEl("button", { text: "Push to Anki", cls: "mod-cta" });
        pushB.addEventListener("click", () => this.plugin.withOp("pushing studio card",
            async () => {
                const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                    "/cardstudio/push", { card_type: this.studio.sel, fields: grab() });
                if (!r || r.ok === false) throw new Error((r && r.error) || "Push failed.");
                new obsidian.Notice("Card pushed.");
            }, pushB));
        const expB = acts.createEl("button", { text: "Export .apkg" });
        expB.addEventListener("click", () => this.plugin.withOp("exporting studio card",
            async () => {
                const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                    "/cardstudio/export", { card_type: this.studio.sel, fields: grab() });
                if (!r || r.ok === false || !r.path) {
                    throw new Error((r && r.error) || "Export failed.");
                }
                new obsidian.Notice(`Exported → ${this.plugin.copyApkg(r.path)}`, 8000);
            }, expB));

        const src = el.createDiv({ cls: "lingua-pending" });
        src.createEl("h3", { text: "Template source" });
        for (const [label, key] of [["Front", "front"], ["Back", "back"], ["Styling", "css"]]) {
            const det = src.createEl("details", { cls: "lingua-template-block" });
            det.createEl("summary", { text: label });
            det.createEl("pre", { text: String(t[key] || "—") });
        }
    }


    /* ----- Stack Studio: ordered multi-step deck builder ----- */

    render_stack(el) {
        el.createDiv({ cls: "lingua-lede",
            text: "Stack Studio composes several builder batches into one ordered "
                + ".apkg — each step becomes a subdeck with its own card type. "
                + "Reorder steps, preview the flow, and export a complete learning sequence." });

        /* Step 1: pick which batches to include */
        const pickSec = el.createDiv({ cls: "lingua-pending" });
        pickSec.createEl("h3", { text: "1. Select batches" });
        pickSec.createDiv({ cls: "lingua-hint",
            text: "Only builder types with at least one row appear. Drag to reorder steps." });

        const withRows = [];
        for (const type of Object.keys(CARD_REGISTRY.specs)) {
            const b = this.plugin.batchFor(type);
            if (b.rows.length) withRows.push([type, b]);
        }

        if (!withRows.length) {
            pickSec.createDiv({ cls: "lingua-empty",
                text: "No builder batches yet — add cards in Builders first." });
            return;
        }

        /* Draggable list */
        const list = pickSec.createDiv({ cls: "lingua-stack-list" });
        this.tools.stackOrder = this.tools.stackOrder || [];
        const selectedTypes = new Set(this.tools.stackSel || []);
        for (const [type, b] of withRows) {
            const spec = specFor(type);
            const item = list.createEl("div", { cls: "lingua-stack-item", attr: { "data-type": type } });
            if (!selectedTypes.has(type)) item.addClass("is-dimmed");

            const drag = item.createEl("span", { cls: "lingua-stack-drag", text: "⋮⋮" });
            const cb = item.createEl("input", { attr: { type: "checkbox" } });
            cb.checked = selectedTypes.has(type);
            cb.addEventListener("change", () => {
                if (cb.checked) selectedTypes.add(type);
                else selectedTypes.delete(type);
                item.toggleClass("is-dimmed", !cb.checked);
                this.tools.stackSel = [...selectedTypes];
                this.updateStackPreview();
            });

            const info = item.createEl("div", { cls: "lingua-stack-info" });
            info.createEl("strong", { text: spec.title });
            info.createEl("span", { cls: "lingua-stack-meta", text: ` — ${b.rows.length} card(s) · ${spec.archetype} · ${spec.deck}` });

            drag.addEventListener("mousedown", (e) => this.startDrag(item, e, list));
        }
        this.tools.stackSel = [...selectedTypes];

        /* Step 2: configure deck naming & options */
        const cfgSec = el.createDiv({ cls: "lingua-pending" });
        cfgSec.createEl("h3", { text: "2. Configure export" });

        const form = cfgSec.createDiv({ cls: "lingua-form" });
        const deckWrap = form.createDiv({ cls: "lingua-field" });
        deckWrap.createEl("label", { text: "Parent deck name" });
        const sdeck = deckWrap.createEl("input", {
            attr: { type: "text", placeholder: `${this.plugin.settings.deckPrefix}::Stack` },
            cls: "lingua-stack-deck-input" });
        sdeck.value = this.tools.stackDeckName || `${this.plugin.settings.deckPrefix}::Stack`;
        sdeck.addEventListener("input", () => { this.tools.stackDeckName = sdeck.value; });

        const optsRow = form.createDiv({ cls: "lingua-field lingua-field-wide" });
        optsRow.createEl("label", { text: "Options" });
        const shuffle = optsRow.createEl("input", { attr: { type: "checkbox", id: "stack-shuffle" } });
        shuffle.checked = this.tools.stackShuffle || false;
        shuffle.addEventListener("change", () => { this.tools.stackShuffle = shuffle.checked; });
        optsRow.createEl("label", { attr: { for: "stack-shuffle" }, text: "Shuffle cards within each step" });

        /* Step 3: live preview of the stack */
        const previewSec = el.createDiv({ cls: "lingua-pending" });
        previewSec.createEl("h3", { text: "3. Preview" });
        this.stackPreviewEl = previewSec.createDiv({ cls: "lingua-stack-preview" });
        this.updateStackPreview();

        /* Step 4: export */
        const actSec = el.createDiv({ cls: "lingua-actions" });
        const expBtn = actSec.createEl("button", { text: "Export stack .apkg", cls: "mod-cta" });
        expBtn.addEventListener("click", () => this.exportBuilderStack(expBtn));
    }


    updateStackPreview() {
        if (!this.stackPreviewEl) return;
        const el = this.stackPreviewEl;
        el.empty();

        const selected = this.tools.stackSel || [];
        if (!selected.length) {
            el.createDiv({ cls: "lingua-empty", text: "Tick batches above to build a stack" });
            return;
        }

        const ol = el.createEl("ol", { cls: "lingua-stack-steps" });
        let total = 0;
        for (const [i, type] of selected.entries()) {
            const spec = specFor(type);
            const b = this.plugin.batchFor(type);
            const li = ol.createEl("li", { cls: "lingua-stack-step" });
            const num = li.createEl("span", { cls: "lingua-step-num", text: i + 1 });
            const info = li.createEl("div", { cls: "lingua-step-info" });
            info.createEl("strong", { text: spec.title });
            info.createEl("span", { cls: "lingua-step-meta", text: ` — ${b.rows.length} cards · ${spec.archetype} → ${spec.deck}` });
            total += b.rows.length;
        }
        el.createDiv({ cls: "lingua-stack-summary", text: `${selected.length} step(s), ${total} total cards` });
    }


    startDrag(item, e, list) {
        e.preventDefault();
        const ghost = item.cloneNode(true);
        ghost.classList.add("is-dragging");
        ghost.style.position = "fixed";
        ghost.style.left = e.clientX + "px";
        ghost.style.top = e.clientY + "px";
        ghost.style.pointerEvents = "none";
        ghost.style.zIndex = 9999;
        ghost.style.opacity = "0.8";
        document.body.appendChild(ghost);

        const rect = item.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;

        const move = (ev) => {
            ghost.style.left = (ev.clientX - offsetX) + "px";
            ghost.style.top = (ev.clientY - offsetY) + "px";
            const after = this.getDragAfterElement(list, ev.clientY);
            const dragging = list.querySelector(".lingua-stack-item.is-dragging-source");
            if (after == null) list.appendChild(dragging);
            else list.insertBefore(dragging, after);
        };

        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            ghost.remove();
            const dragging = list.querySelector(".lingua-stack-item.is-dragging-source");
            if (dragging) dragging.classList.remove("is-dragging-source");
            this.syncStackOrder(list);
        };

        item.classList.add("is-dragging-source");
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    }


    getDragAfterElement(container, y) {
        const items = [...container.querySelectorAll(".lingua-stack-item:not(.is-dragging-source)")];
        return items.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) {
                return { offset, element: child };
            }
            return closest;
        }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
    }


    syncStackOrder(list) {
        const items = [...list.querySelectorAll(".lingua-stack-item")];
        this.tools.stackSel = items
            .filter((it) => it.querySelector("input[type=checkbox]").checked)
            .map((it) => it.dataset.type);
        this.updateStackPreview();
    }


    async exportBuilderStack(btn) {
        const steps = (this.tools.stackSel || []).map((type) => {
            const spec = specFor(type);
            return { cardType: type, batch: batchPayload(this.plugin.batchFor(type).rows),
                label: spec.title, deckName: spec.deck || spec.title };
        });
        if (!steps.length) { new obsidian.Notice("No steps selected"); return; }

        const deckName = this.tools.stackDeckName
            || `${this.plugin.settings.deckPrefix}::Stack`;

        await this.plugin.withOp("exporting stack", async () => {
            const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                "/export/stack", { steps, deck_name: deckName, lang: this.lang.lingua });
            if (!r || r.ok === false || !r.path) {
                throw new Error((r && r.error) || "Stack export failed.");
            }
            new obsidian.Notice(`Stack exported → ${this.plugin.copyApkg(r.path)}`, 8000);
        }, btn);
    }


    /* ----- Tools: OCR, images ----- */

    // Shared "send these lines into a builder" row (Import + OCR).
    sendLinesUI(parent, getText) {
        const send = parent.createDiv({ cls: "lingua-actions" });
        const target = send.createEl("select", { cls: "dropdown" });
        target.createEl("option", { value: "", text: "— send lines to… —" });
        const open = this.batch();
        if (open) target.createEl("option", { value: "__batch", text: `Words → ${open.name}` });
        for (const group of CARD_REGISTRY.groups) {
            for (const type of group.types) {
                const spec = specFor(type);
                if (spec) target.createEl("option", { value: type, text: spec.title });
            }
        }
        const sendB = send.createEl("button", { text: "Send", cls: "mod-cta" });
        sendB.addEventListener("click", async () => {
            if (target.value === "__batch" && open) {
                const terms = getText().split("\n").flatMap((l) => v4SplitWords(l));
                if (!terms.length) { new obsidian.Notice("Nothing to send."); return; }
                await this.addWords(open.id, terms, "Import");
                return;
            }
            const spec = specFor(target.value);
            if (!spec) { new obsidian.Notice("Pick a builder."); return; }
            const rows = linesToRows(getText(), spec);
            for (const row of rows) await this.plugin.addBatchRow(target.value, row);
            new obsidian.Notice(`${rows.length} line(s) → ${spec.title}`);
        });
    }


    render_tools(el) {
        // --- Import ---
        const imp = el.createDiv({ cls: "lingua-pending" });
        imp.createEl("h3", { text: "Import" });
        imp.createDiv({ cls: "lingua-hint",
            text: "Paste a word or sentence list — one item per line — and send "
                + "it into any builder's batch." });
        const impTa = imp.createEl("textarea", { cls: "lingua-ocr-text",
            attr: { rows: 5, placeholder: "one item per line" } });
        this.sendLinesUI(imp, () => impTa.value);

        // --- OCR ---
        const ocr = el.createDiv({ cls: "lingua-pending" });
        ocr.createEl("h3", { text: "OCR" });
        ocr.createDiv({ cls: "lingua-hint",
            text: "Read text out of an image, then send it line-by-line into any "
                + "builder's batch." });
        const orow = ocr.createDiv({ cls: "lingua-actions" });
        const file = orow.createEl("input", { attr: { type: "file", accept: "image/*" } });
        const runB = orow.createEl("button", { text: "Read image", cls: "mod-cta" });
        runB.addEventListener("click", () => this.plugin.withOp("running OCR", async () => {
            const f = file.files && file.files[0];
            if (!f) throw new Error("Pick an image first.");
            const buf = await f.arrayBuffer();
            let bin = "";
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            // Ported off LinguaStudio's dead :8000 — the vault sidecar has its
            // own /ocr (app/routers/ocr.py, tesseract-backed), used elsewhere
            // for scanned PDFs with no text layer. Same tesseract language
            // codes, so the lang mapping below is unchanged; the body shape
            // takes an ARRAY of page images (batch OCR), so one image is
            // wrapped in a single-element array. Errors raise HTTPException
            // rather than returning {ok:false}, and withOp's own catch already
            // turns a thrown error into a Notice, so no r.ok check is needed.
            const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                "/ocr", { images: [btoa(bin)],
                    lang: ocrPackFor(this.lang.vault) });
            this.tools.ocrText = (r && r.text) || "";
            this.render();
        }, runB));
        if (this.tools.ocrText) {
            const ta = ocr.createEl("textarea", { cls: "lingua-ocr-text",
                attr: { rows: 6 } });
            ta.value = this.tools.ocrText;
            ta.addEventListener("input", () => { this.tools.ocrText = ta.value; });
            this.sendLinesUI(ocr, () => this.tools.ocrText);
        }

        // --- Whisper (speech-to-text) ---
        const wh = el.createDiv({ cls: "lingua-pending" });
        wh.createEl("h3", { text: "Transcribe audio" });
        wh.createDiv({ cls: "lingua-hint",
            text: "Turn a listening clip (dictation, a podcast excerpt) into text, "
                + "then send it line-by-line into any builder's batch. Runs fully "
                + "local through the vault sidecar's own Whisper model — nothing "
                + "leaves this machine." });
        const wrow = wh.createDiv({ cls: "lingua-actions" });
        const wfile = wrow.createEl("input", { attr: { type: "file", accept: "audio/*" } });
        const wRunB = wrow.createEl("button", { text: "Transcribe", cls: "mod-cta" });
        wRunB.addEventListener("click", () => this.plugin.withOp("transcribing audio",
            async () => {
                const f = wfile.files && wfile.files[0];
                if (!f) throw new Error("Pick an audio file first.");
                if (whisperTooLarge(f.size)) {
                    throw new Error(`File is ${(f.size / (1024 * 1024)).toFixed(1)}MB — keep `
                        + `clips under ${MAX_WHISPER_AUDIO_BYTES / (1024 * 1024)}MB for now `
                        + "(CPU transcription runs roughly real-time; a long file can look hung).");
                }
                const buf = await f.arrayBuffer();
                const audio = bytesToBase64(new Uint8Array(buf));
                const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                    "/whisper/transcribe", { audio, mime: whisperMime(f) });
                if (!r || r.ok === false) throw new Error((r && r.error) || "Transcription failed.");
                this.tools.whisperText = whisperText(r);
                this.render();
            }, wRunB));
        if (this.tools.whisperText) {
            const wta = wh.createEl("textarea", { cls: "lingua-ocr-text",
                attr: { rows: 6 } });
            wta.value = this.tools.whisperText;
            wta.addEventListener("input", () => { this.tools.whisperText = wta.value; });
            this.sendLinesUI(wh, () => this.tools.whisperText);
        }

        // --- Images ---
        const img = el.createDiv({ cls: "lingua-pending" });
        img.createEl("h3", { text: "Images" });
        img.createDiv({ cls: "lingua-hint",
            text: "Find a picture for visual cards. Fetching stores it in "
                + "LinguaStudio's media folder and gives you the filename to put "
                + "in an image field." });
        const irow = img.createDiv({ cls: "lingua-actions" });
        const iq = irow.createEl("input", { attr: { type: "text",
            placeholder: "word — e.g. 苹果" } });
        iq.value = this.tools.imgQuery;
        const searchB = irow.createEl("button", { text: "Search", cls: "mod-cta" });
        searchB.addEventListener("click", () => this.plugin.withOp("searching images",
            async () => {
                this.tools.imgQuery = iq.value;
                const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                    "/images/search", { word: iq.value.trim(), meaning: "",
                        maxResults: 12 });
                if (!r || r.ok === false) throw new Error((r && r.error) || "Search failed.");
                this.tools.images = r.results || [];
                this.render();
            }, searchB));
        if (this.tools.images.length) {
            const grid = img.createDiv({ cls: "lingua-img-grid" });
            for (const res of this.tools.images) {
                const cell = grid.createDiv({ cls: "lingua-img-cell",
                    attr: { title: `${res.source || ""} — click to fetch` } });
                if (res.thumbB64 || res.thumb) {
                    cell.createEl("img", { attr: {
                        src: res.thumbB64 ? `data:image/jpeg;base64,${res.thumbB64}`
                            : res.thumb } });
                } else {
                    cell.setText(res.title || res.url || "image");
                }
                cell.addEventListener("click", () => this.plugin.withOp("fetching image",
                    async () => {
                        const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                            "/images/fetch", { url: res.url, word: iq.value.trim(),
                                source: res.source || "", license: res.license || "",
                                credit: res.credit || "" });
                        if (!r || r.ok === false || !r.filename) {
                            throw new Error((r && r.error) || "Fetch failed.");
                        }
                        navigator.clipboard.writeText(r.filename);
                        new obsidian.Notice(`Saved ${r.filename} (copied to clipboard).`, 8000);
                    }));
            }
        }

        }


    /* ----- TTS ----- */

    render_tts(el) {
        el.createDiv({ cls: "lingua-lede",
            text: "The vault sidecar's own text-to-speech — edge-tts (online, free, "
                + "many voices), piper (local, offline, no GPU), or gTTS (online, "
                + "simple fallback). Pick an engine, load its voices, hear one, and "
                + "warm the audio cache the builders draw from. No LinguaStudio "
                + "process required for any of this." });

        const bar = el.createDiv({ cls: "lingua-form" });
        const engWrap = bar.createDiv({ cls: "lingua-field" });
        engWrap.createEl("label", { text: "Engine" });
        const eng = engWrap.createEl("select");
        eng.createEl("option", { value: "edge", text: "Edge-TTS (online, free)" });
        eng.createEl("option", { value: "piper", text: "Piper (local, offline)" });
        eng.createEl("option", { value: "gtts", text: "Google TTS (online, fallback)" });
        eng.value = this.tts.engine;
        eng.addEventListener("change", () => {
            this.tts.engine = eng.value;
            this.tts.voices = null;
            this.tts.voice = "";
            // Remembered as the tab's own starting point next time it opens —
            // "add these in the settings" was the ask, not "only in settings",
            // so changing the engine here is what actually updates the default.
            this.plugin.settings.ttsDefaultEngine = eng.value;
            this.plugin.saveSettings();
            this.render();
        });
        const loadBtn = bar.createEl("button", {
            text: this.tts.voices ? "Reload voices" : "Load voices", cls: "mod-cta" });
        loadBtn.addEventListener("click", () => this.plugin.withOp("loading voices",
            async () => {
                this.tts.engine = eng.value;
                const voices = await call("vault", this.plugin.settings.vaultSidecarUrl,
                    `/tts/voices?engine=${encodeURIComponent(eng.value)}`
                    + `&lang=${encodeURIComponent(this.lang.lingua)}`);
                this.tts.voices = Array.isArray(voices) ? voices : [];
                if (this.tts.voices.length && !this.tts.voice) {
                    this.tts.voice = ttsVoiceId(this.tts.voices[0]);
                }
                this.render();
            }, loadBtn));

        if (!this.tts.voices) {
            el.createDiv({ cls: "lingua-empty",
                text: `Load voices for ${this.lang.name}.` });
        } else if (!this.tts.voices.length) {
            const why = this.tts.engine === "piper"
                ? `Piper has no curated voice for ${this.lang.name} yet, or piper-tts `
                  + "isn't installed in the sidecar's venv (`pip install -r "
                  + "sidecar/requirements.txt`)."
                : this.tts.engine === "gtts"
                ? "gTTS may be unavailable in the vault sidecar (`pip install -r "
                  + "sidecar/requirements.txt`, then check the sidecar's own log)."
                : "edge-tts may be unavailable in the vault sidecar (confirm `pip "
                  + "install -r sidecar/requirements.txt` ran, and check the "
                  + "sidecar's own log for the actual error).";
            el.createDiv({ cls: "lingua-empty", text: "No voices — " + why });
        } else {
            const form = el.createDiv({ cls: "lingua-form" });
            const vWrap = form.createDiv({ cls: "lingua-field" });
            vWrap.createEl("label", { text: `Voice (${this.tts.voices.length})` });
            const vsel = vWrap.createEl("select");
            for (const v of this.tts.voices) {
                vsel.createEl("option", { value: ttsVoiceId(v), text: ttsVoiceLabel(v) });
            }
            if (this.tts.voice) vsel.value = this.tts.voice;
            vsel.addEventListener("change", () => {
                this.tts.voice = vsel.value;
                this.plugin.settings.ttsDefaultVoice = vsel.value;
                this.plugin.saveSettings();
            });

            const tWrap = form.createDiv({ cls: "lingua-field lingua-field-wide" });
            tWrap.createEl("label", { text: "Text" });
            const ta = tWrap.createEl("textarea", { attr: { rows: 2,
                placeholder: "type a word or sentence to hear" } });
            ta.value = this.tts.text;
            ta.addEventListener("input", () => { this.tts.text = ta.value; });

            const acts = el.createDiv({ cls: "lingua-actions" });
            const play = acts.createEl("button", { text: "Preview", cls: "mod-cta" });
            play.addEventListener("click", () => this.plugin.withOp("previewing voice",
                async () => {
                    this.tts.voice = vsel.value;
                    if (!ta.value.trim()) throw new Error("Type some text first.");
                    const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                        "/tts/preview", { voice: vsel.value, text: ta.value.trim(),
                            engine: this.tts.engine, lang: this.lang.lingua });
                    if (!r || r.ok === false) throw new Error((r && r.error) || "Preview failed.");
                    const b64 = ttsAudioB64(r);
                    if (b64) {
                        // A real transport (play/pause/seek/volume), not a fire-
                        // and-forget Audio().play() — there was previously no way
                        // to pause a preview once it started.
                        this.tts.previewAudio = b64;
                        this.render();
                    } else {
                        new obsidian.Notice("Voice ok, but no audio came back.");
                    }
                }, play));

            if (this.tts.previewAudio) {
                const player = el.createEl("audio", {
                    cls: "lingua-tts-player",
                    attr: { controls: true, autoplay: true } });
                player.src = "data:audio/mpeg;base64," + this.tts.previewAudio;
            }
        }

        // cache
        const cache = el.createDiv({ cls: "lingua-pending" });
        cache.createEl("h3", { text: "Audio cache" });
        const crow = cache.createDiv({ cls: "lingua-actions" });
        const stat = crow.createEl("button", { text: "Check size" });
        const label = cache.createDiv({ cls: "lingua-hint",
            text: this.tts.cacheBytes == null ? ""
                : `${(this.tts.cacheBytes / 1048576).toFixed(1)} MB cached` });
        stat.addEventListener("click", () => this.plugin.withOp("reading cache", async () => {
            const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                "/tts/cache/stats");
            this.tts.cacheBytes = (r && r.bytes) || 0;
            this.render();
        }, stat));
        const clear = crow.createEl("button", { text: "Clear cache" });
        clear.addEventListener("click", () => this.plugin.withOp("clearing cache", async () => {
            const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                "/tts/cache/clear");
            new obsidian.Notice(`Cleared ${(r && r.deleted) || 0} file(s).`);
            this.tts.cacheBytes = 0;
            this.render();
        }, clear));
        label; // rendered above; keep reference for clarity
    }


    /* ----- Example sentences ----- */

    render_sentences(el) {
        el.createDiv({ cls: "lingua-lede",
            text: "Mandarin ships a corpus; add more languages under Manage → Languages. "
                + "Use a sentence as a word's example in the open batch, keep the "
                + "word in the Inbox, or cloze the sentence." });

        const bar = el.createDiv({ cls: "lingua-form lingua-dict-bar" });
        const q = bar.createEl("input", { attr: { type: "text",
            placeholder: "word to find in sentences…" } });
        q.value = this.sent.word;
        const go = bar.createEl("button", { text: "Find", cls: "mod-cta" });
        const find = () => this.plugin.withOp("looking up sentences", async () => {
            this.sent.word = q.value.trim();
            if (!this.sent.word) return;
            const url = `/sentences/lookup?word=${encodeURIComponent(this.sent.word)}`
                + `&lang=${encodeURIComponent(this.lang.lingua)}&limit=25`;
            const r = await call("lingua", this.plugin.settings.linguaSidecarUrl, url);
            this.sent.results = (r && r.sentences) || [];
            this.render();
        }, go);
        go.addEventListener("click", find);
        q.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); find(); }
        });

        if (!this.sent.results.length) {
            el.createDiv({ cls: "lingua-empty",
                text: `Sentences containing a word appear here. If none come back, `
                    + `install a ${this.lang.name} pack under Manage.` });
            return;
        }
        const box = el.createDiv({ cls: "lingua-pending" });
        box.createEl("h3", { text: `Sentences — ${this.sent.results.length}` });
        for (const s of this.sent.results) {
            const text = sentenceText(s);
            const gloss = sentenceGloss(s);
            const row = box.createDiv({ cls: "lingua-sentence-row" });
            const body = row.createDiv({ cls: "lingua-sentence-body" });
            body.createDiv({ cls: "lingua-sentence-text", text });
            if (gloss) body.createDiv({ cls: "lingua-sentence-gloss", text: gloss });
            const tools = row.createDiv({ cls: "lingua-row-tools" });
            const open = this.batch();
            const owner = open && open.words.find((w) => w.S === this.sent.word);
            if (owner) {
                this.rowTool(tools, "list-plus", `Use as the example for ${owner.S}`, async () => {
                    await this.mutWords([owner.id], () => ({ Sent: text, ST: gloss, SP: "" }), open.id);
                    new obsidian.Notice(`Example set for ${owner.S} in ${open.name}.`);
                });
            }
            this.rowTool(tools, "inbox", "Keep the word in the Inbox", async () => {
                await this.plugin.addPending(this.lang.vault,
                    { term: this.sent.word, reading: "", gloss: text, rhythm: "", ts: Date.now(), source: "Sentences" });
                this.plugin.refreshNav();
                new obsidian.Notice("→ Inbox");
            });
            this.rowTool(tools, "brackets", "Cloze this sentence", async () => {
                const clozed = text.replace(this.sent.word,
                    `{{c1::${this.sent.word}}}`);
                await this.plugin.addBatchRow("custom_cloze", { cloze: clozed, gloss });
                new obsidian.Notice("→ Builders → Cloze");
            });
        }
    }


    /* ----- Manage: dictionaries + sentence packs ----- */

    render_manage(el) {
        el.createDiv({ cls: "lingua-lede",
            text: "Install more languages: download dictionaries and example-"
                + "sentence packs, or import your own files. Downloads run in the "
                + "engine — the list refreshes as they finish." });
        this.renderPackManager(el, "dict", "Dictionaries");
        this.renderPackManager(el, "sentences", "Sentence packs");
    }

    /* Reading Companion, or null — duck-typed, not merely present. An older
       build without the study surface would satisfy plugins[id] and then
       throw on the first call; checking the capability is the difference
       between degrading and crashing. Mirrors flashcards-workspace's own
       companion() exactly, because it exists for the identical reason. */

    readingCompanion() {
        const p = this.app.plugins && this.app.plugins.plugins
            && this.app.plugins.plugins["reading-companion"];
        if (!p || typeof p.openStudy !== "function") return null;
        return p;
    }


    renderPackManager(el, kind, heading) {
        const cfg = PACK_KINDS[kind];
        const box = el.createDiv({ cls: "lingua-pending" });
        const head = box.createDiv({ cls: "lingua-pending-head" });
        head.createEl("h3", { text: heading });
        const load = head.createEl("button", {
            text: this.packs[kind] ? "Refresh" : "Load" });
        load.addEventListener("click", () => this.loadPacks(kind));

        const list = this.packs[kind];
        if (list === null) {
            box.createDiv({ cls: "lingua-empty", text: "Load to see what's available." });
        } else if (!list.length) {
            box.createDiv({ cls: "lingua-empty", text: "Nothing listed." });
        } else {
            const table = box.createEl("table", { cls: "lingua-table" });
            const thead = table.createEl("thead").createEl("tr");
            for (const h of ["language", "status", ""]) thead.createEl("th", { text: h });
            const tbody = table.createEl("tbody");
            for (const pk of list) {
                const name = pk.name || pk.label || pk.lang || pk.language || "?";
                const code = pk.lang || pk.code || pk.language || "";
                const st = packStatus(pk);
                const tr = tbody.createEl("tr");
                tr.createEl("td", { text: name, cls: "lingua-term" });
                tr.createEl("td", { text: st.label,
                    cls: st.busy ? "lingua-pack-busy" : "" });
                const tools = tr.createEl("td", { cls: "lingua-row-tools" });
                if (st.installed) {
                    this.rowTool(tools, "trash-2", "Remove", () => this.delPack(kind, code));
                } else if (!st.busy) {
                    this.rowTool(tools, "download", "Download",
                        () => this.downloadPack(kind, code));
                }
            }
        }

        // import a local file
        const imp = box.createDiv({ cls: "lingua-actions" });
        const path = imp.createEl("input", { attr: { type: "text",
            placeholder: cfg.importLabel } });
        const code = imp.createEl("input", { attr: { type: "text",
            placeholder: "lang code (e.g. deu)" } });
        code.style.maxWidth = "9em";
        const impBtn = imp.createEl("button", { text: "Import" });
        impBtn.addEventListener("click", () => this.plugin.withOp(`importing ${kind}`,
            async () => {
                if (!path.value.trim() || !code.value.trim()) {
                    throw new Error("Give both a file path and a language code.");
                }
                const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                    cfg.importRoute, { path: path.value.trim(), lang: code.value.trim() });
                if (r && r.ok === false) throw new Error(r.error || "Import failed.");
                new obsidian.Notice("Import started — Refresh to watch progress.");
            }, impBtn));
    }


    async loadPacks(kind) {
        const cfg = PACK_KINDS[kind];
        await this.plugin.withOp(`loading ${kind}`, async () => {
            const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                cfg.available);
            this.packs[kind] = (r && r[cfg.listKey]) || [];
            this.render();
        });
    }


    async downloadPack(kind, code) {
        const cfg = PACK_KINDS[kind];
        await this.plugin.withOp(`downloading ${code}`, async () => {
            const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                cfg.download, { lang: code });
            if (r && r.ok === false) throw new Error(r.error || "Download failed to start.");
            new obsidian.Notice(`${code} downloading — Refresh to watch progress.`);
            await this.loadPacks(kind);
        });
    }


    async delPack(kind, code) {
        const cfg = PACK_KINDS[kind];
        await this.plugin.withOp(`removing ${code}`, async () => {
            const r = await obsidian.requestUrl({
                url: String(this.plugin.settings.linguaSidecarUrl).replace(/\/$/, "")
                    + `${cfg.del}/${encodeURIComponent(code)}`,
                method: "DELETE", throw: false });
            const j = (() => { try { return r.json; } catch (e) { return null; } })();
            if (j && j.ok === false) throw new Error(j.error || "Remove refused.");
            new obsidian.Notice(`Removed ${code}.`);
            await this.loadPacks(kind);
        });
    }


    /* ----- Cascade (custom two-mode builder) ----- */

    renderCascade(el, spec, batch) {
        const c = this.cascade;

        const deckRow = el.createDiv({ cls: "lingua-form" });
        const deckWrap = deckRow.createDiv({ cls: "lingua-field" });
        deckWrap.createEl("label", { text: "Deck" });
        const deck = deckWrap.createEl("input", { attr: { type: "text",
            placeholder: spec.deck } });
        deck.value = batch.deck || spec.deck || "";
        deck.addEventListener("change", () => this.plugin.setBatchDeck("cascade", deck.value));

        // mode chips
        const modeRow = el.createDiv({ cls: "lingua-chip-row" });
        for (const m of [{ id: "cascade", label: "⚡ Cascade" },
                         { id: "reading", label: "📖 Reading" }]) {
            const chip = modeRow.createEl("button", {
                cls: "lingua-chip" + (c.mode === m.id ? " is-active" : ""),
                text: m.label });
            chip.addEventListener("click", () => { c.mode = m.id; this.render(); });
        }

        const form = el.createDiv({ cls: "lingua-builder-form" });
        const numField = (parent, label, key, min, max, wide) => {
            const w = parent.createDiv({ cls: "lingua-field" + (wide ? " lingua-field-wide" : "") });
            w.createEl("label", { text: label });
            const inp = w.createEl("input", { attr: { type: "number", min, max } });
            inp.value = String(c[key]);
            inp.addEventListener("change", () => {
                let v = parseInt(inp.value, 10);
                if (isNaN(v)) v = c[key];
                c[key] = Math.max(min, Math.min(max, v));
                inp.value = String(c[key]);
            });
            return inp;
        };
        const selField = (parent, label, key, opts) => {
            const w = parent.createDiv({ cls: "lingua-field" });
            w.createEl("label", { text: label });
            const sel = w.createEl("select");
            for (const o of opts) sel.createEl("option", { value: o.value, text: o.label });
            sel.value = c[key];
            sel.addEventListener("change", () => { c[key] = sel.value;
                if (key === "meter") this.render(); });
            return sel;
        };

        const titleWrap = form.createDiv({ cls: "lingua-field" });
        titleWrap.createEl("label", { text: "Title (optional)" });
        const title = titleWrap.createEl("input", { attr: { type: "text",
            placeholder: "auto if blank" } });
        title.value = c.title;
        title.addEventListener("input", () => { c.title = title.value; });

        if (c.mode === "reading") {
            numField(form, "WPM", "wpm", 20, 400);
            const pw = form.createDiv({ cls: "lingua-field lingua-field-wide" });
            pw.createEl("label", { text: "Passage" });
            const ta = pw.createEl("textarea", { attr: { rows: 4,
                placeholder: "paste or type the passage" } });
            ta.value = c.text;
            ta.addEventListener("input", () => { c.text = ta.value; });
        } else {
            numField(form, "BPM (start)", "bpm", 20, 300);
            const pw = form.createDiv({ cls: "lingua-field lingua-field-wide" });
            pw.createEl("label", { text: "Words (space / newline separated)" });
            const ta = pw.createEl("textarea", { attr: { rows: 3,
                placeholder: "你好 谢谢 再见 — each flashes on its beat" } });
            ta.value = c.text;
            ta.addEventListener("input", () => { c.text = ta.value; });

            const cfg1 = form.createDiv({ cls: "lingua-field-row lingua-field-wide" });
            selField(cfg1, "Pattern", "pattern", CASCADE_PATTERNS);
            selField(cfg1, "Meter", "meter",
                CASCADE_METERS.map((m) => ({ value: m.value, label: m.value })));
            numField(cfg1, "Rest rounds", "gapCycles", 0, 8);
            selField(cfg1, "Sub÷", "subdiv",
                [1, 2, 3, 4].map((n) => ({ value: String(n),
                    label: n === 1 ? "every beat" : `every ${n} beats` })));
            selField(cfg1, "Display", "dispMode", CASCADE_DISPLAY);

            // subdiv is a number stored as string via select — normalize
            c.subdiv = parseInt(c.subdiv, 10) || 1;

            const beatsWrap = form.createDiv({ cls: "lingua-field lingua-field-wide" });
            beatsWrap.createEl("label", { text: "Speak on beats" });
            const chips = beatsWrap.createDiv({ cls: "lingua-beat-chips" });
            const count = cascadeMeterCount(c.meter);
            c.ttsBeats = c.ttsBeats.filter((b) => b <= count);
            if (!c.ttsBeats.length) c.ttsBeats = [1];
            for (let b = 1; b <= count; b++) {
                const on = c.ttsBeats.includes(b);
                const chip = chips.createEl("button", {
                    cls: "lingua-beat-chip" + (on ? " is-active" : ""), text: String(b) });
                chip.addEventListener("click", () => {
                    const has = c.ttsBeats.includes(b);
                    const next = has ? c.ttsBeats.filter((x) => x !== b)
                        : [...c.ttsBeats, b].sort((x, y) => x - y);
                    c.ttsBeats = next.length ? next : c.ttsBeats;
                    this.render();
                });
            }
            const rand = beatsWrap.createEl("label", { cls: "lingua-check" });
            const rcb = rand.createEl("input", { attr: { type: "checkbox" } });
            rcb.checked = c.randomize;
            rcb.addEventListener("change", () => { c.randomize = rcb.checked; });
            rand.createSpan({ text: " 🎲 Randomize word order" });

            const wr = form.createDiv({ cls: "lingua-field lingua-field-wide" });
            const wlab = wr.createEl("label", { cls: "lingua-check" });
            const wcb = wlab.createEl("input", { attr: { type: "checkbox" } });
            wcb.checked = c.writingOn;
            wcb.addEventListener("change", () => { c.writingOn = wcb.checked; this.render(); });
            wlab.createSpan({ text: " ✍ Writing practice" });

            if (c.writingOn) {
                const wrow = form.createDiv({ cls: "lingua-field-row lingua-field-wide" });
                numField(wrow, "Write every", "writeEvery", 1, 20);
                numField(wrow, "Time limit (s)", "timeLimit", 5, 120);
                for (const [key, text] of [["metroWrite", "Metronome during writing"],
                        ["strokeDemo", "Stroke demo intro"],
                        ["showOutline", "Character outline"]]) {
                    const l = wrow.createEl("label", { cls: "lingua-check" });
                    const cb = l.createEl("input", { attr: { type: "checkbox" } });
                    cb.checked = c[key];
                    cb.addEventListener("change", () => { c[key] = cb.checked; });
                    l.createSpan({ text: " " + text });
                }
            }
        }

        const addRow = el.createDiv({ cls: "lingua-actions" });
        addRow.createEl("button", { text: "Add to batch", cls: "mod-cta" })
            .addEventListener("click", async () => {
                if (!c.text.trim()) {
                    new obsidian.Notice(c.mode === "reading"
                        ? "Enter a passage first." : "Enter one or more words first.");
                    return;
                }
                const t = c.title.trim()
                    || c.text.trim().split(/\s+/).slice(0, 4).join(" ");
                const row = c.mode === "reading"
                    ? { mode: "reading", title: t, text: c.text.trim(), wpm: c.wpm }
                    : { mode: "cascade", title: t, text: c.text.trim(),
                        bpm: c.bpm, pattern: c.pattern, meter: c.meter,
                        dispMode: c.dispMode, ttsBeats: [...c.ttsBeats],
                        gapCycles: c.gapCycles, subdiv: c.subdiv,
                        randomize: c.randomize, writingOn: c.writingOn,
                        writeEvery: c.writeEvery, timeLimit: c.timeLimit,
                        metroWrite: c.metroWrite, strokeDemo: c.strokeDemo,
                        showOutline: c.showOutline };
                await this.plugin.addBatchRow("cascade", row);
                c.title = ""; c.text = "";
                this.render();
            });

        // batch list
        const box = el.createDiv({ cls: "lingua-pending" });
        box.createEl("h3", { text: `Batch — ${batch.rows.length}` });
        if (!batch.rows.length) {
            box.createDiv({ cls: "lingua-empty", text: "No cards yet." });
        } else {
            const table = box.createEl("table", { cls: "lingua-table" });
            const thead = table.createEl("thead").createEl("tr");
            for (const h of ["type", "title", "config", ""]) thead.createEl("th", { text: h });
            const tbody = table.createEl("tbody");
            batch.rows.forEach((it, i) => {
                const tr = tbody.createEl("tr");
                tr.createEl("td", { text: it.mode === "reading" ? "📖 reading"
                    : it.writingOn ? "✍ cascade+write" : "⚡ cascade" });
                tr.createEl("td", { text: it.title, cls: "lingua-term" });
                tr.createEl("td", { text: it.mode === "reading"
                    ? `${it.text.trim().split(/\s+/).length}w · ${it.wpm} wpm`
                    : `${it.pattern} · ${it.bpm} bpm`
                        + (it.writingOn ? ` · write/${it.writeEvery}` : "") });
                const tools = tr.createEl("td", { cls: "lingua-row-tools" });
                this.rowTool(tools, "x", "Remove", async () => {
                    await this.plugin.removeBatchRow("cascade", i);
                    this.render();
                });
            });
        }

        const acts = el.createDiv({ cls: "lingua-actions lingua-anki-actions" });
        const deckName = () => deck.value.trim() || spec.deck;
        const run = (label, mode, btn) => this.plugin.withOp(label, async () => {
            if (!batch.rows.length) throw new Error("Nothing to build.");
            const jobs = cascadeJobs(batch.rows, this.lang.lingua);
            let last = "";
            for (const [cardType, sub] of jobs) {
                if (mode === "push") {
                    const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                        `/push/${cardType}`, { batch: sub, deck_name: deckName(),
                            lang: this.lang.lingua });
                    if (!r || r.ok === false) throw new Error((r && r.error) || "Push failed.");
                } else {
                    const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                        `/export/${cardType}`, { batch: sub, deck_name: deckName(),
                            lang: this.lang.lingua });
                    if (!r || r.ok === false || !r.path) {
                        throw new Error((r && r.error) || "Export failed.");
                    }
                    last = this.plugin.copyApkg(r.path);
                }
            }
            new obsidian.Notice(mode === "push"
                ? `Pushed ${batch.rows.length} cascade card(s) to ${deckName()}.`
                : `Exported ${batch.rows.length} card(s) → ${last}`, 8000);
        }, btn);
        const pushB = acts.createEl("button", { text: "Push to Anki", cls: "mod-cta" });
        pushB.addEventListener("click", () => run("pushing Cascade", "push", pushB));
        const expB = acts.createEl("button", { text: "Export .apkg" });
        expB.addEventListener("click", () => run("exporting Cascade", "export", expB));
        const clr = acts.createEl("button", { text: "Clear batch" });
        clr.addEventListener("click", async () => {
            await this.plugin.clearBatch("cascade");
            this.render();
        });
    }


    /* ----- Settings ----- */

    render_settings(el) {
        const s = this.plugin.settings;
        el.createDiv({ cls: "lingua-lede",
            text: "Everything the workspace and its engines use. Changes save immediately." });

        const group = (name) => {
            const box = el.createDiv({ cls: "lingua-pending" });
            box.createEl("h3", { text: name });
            return box;
        };
        const textRow = (box, label, key, ph, onSet) => {
            const row = box.createDiv({ cls: "lingua-field" });
            row.createEl("label", { text: label });
            const inp = row.createEl("input", { attr: { type: "text",
                placeholder: ph || "" } });
            inp.value = s[key] != null ? String(s[key]) : "";
            inp.addEventListener("change", async () => {
                s[key] = inp.value.trim();
                await this.plugin.saveSettings();
                if (onSet) onSet();
            });
            return inp;
        };
        const selectRow = (box, label, key, opts, onSet) => {
            const row = box.createDiv({ cls: "lingua-field" });
            row.createEl("label", { text: label });
            const sel = row.createEl("select");
            for (const o of opts) sel.createEl("option", { value: o, text: o });
            sel.value = s[key];
            sel.addEventListener("change", async () => {
                s[key] = sel.value;
                await this.plugin.saveSettings();
                if (onSet) onSet();
            });
        };
        const toggleRow = (box, label, key, desc) => {
            const row = box.createDiv({ cls: "lingua-field" });
            const l = row.createEl("label", { cls: "lingua-check" });
            const cb = l.createEl("input", { attr: { type: "checkbox" } });
            cb.checked = !!s[key];
            cb.addEventListener("change", async () => {
                s[key] = cb.checked;
                await this.plugin.saveSettings();
            });
            l.createSpan({ text: " " + label });
            if (desc) row.createDiv({ cls: "lingua-hint", text: desc });
        };

        // Appearance — the workspace wears the vault's own theme; only the
        // density is ours. (Card themes are chosen per batch, in Card types.)
        const app = group("Appearance");
        selectRow(app, "Density", "density", ["comfortable", "compact"],
            () => this.plugin.rerenderViews());

        // Backends
        const be = group("Backends");
        textRow(be, "Vault sidecar URL", "vaultSidecarUrl", DEFAULT_SETTINGS.vaultSidecarUrl);
        textRow(be, "LinguaStudio engine URL", "linguaSidecarUrl",
            DEFAULT_SETTINGS.linguaSidecarUrl);
        textRow(be, "AnkiConnect URL", "ankiConnectUrl", DEFAULT_SETTINGS.ankiConnectUrl);
        toggleRow(be, "Start the engine automatically", "autoStartBackend",
            "Launch the LinguaStudio engine when this workspace opens.");

        // Local AI
        const ai = group("Local AI");
        const status = ai.createDiv({ cls: "lingua-hint" });
        status.setText(this.aiProbe == null ? "Not checked yet."
            : this.aiProbe.running
                ? `${this.aiProbe.providerName || "Local AI"} reachable — `
                    + `${(this.aiProbe.models || []).length} model(s).`
                : `Not reachable${this.aiProbe.detail ? " — " + this.aiProbe.detail : ""}.`);
        textRow(ai, "Server URL (blank = auto-detect Ollama / LM Studio)", "aiUrl",
            "blank auto-probes :11434 then :1234");
        textRow(ai, "Model (blank = first installed)", "aiModel", "blank = auto-pick");
        if (this.aiProbe && this.aiProbe.models && this.aiProbe.models.length) {
            ai.createDiv({ cls: "lingua-hint",
                text: "Installed: " + this.aiProbe.models.join(", ") });
        }
        const probe = ai.createEl("button", { text: "Check connection" });
        probe.addEventListener("click", () => this.plugin.withOp("probing AI", async () => {
            const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                "/ai/status", { url: s.aiUrl || "" });
            this.aiProbe = r || { running: false };
            this.render();
        }, probe));

        // Anki
        const anki = group("Anki");
        textRow(anki, "Deck prefix", "deckPrefix", DEFAULT_SETTINGS.deckPrefix);
        textRow(anki, ".apkg export folder", "apkgDir", "~/Downloads");

        // Paths
        const paths = group("Paths");
        textRow(paths, "Vocab note folder", "vocabNoteFolder",
            DEFAULT_SETTINGS.vocabNoteFolder);
        textRow(paths, "Generated folder", "generatedFolder",
            DEFAULT_SETTINGS.generatedFolder);
        toggleRow(paths, "Create a vocab note per captured term", "createVocabNotes");

        // Diagnostics
        const diag = group("Diagnostics");
        diag.createDiv({ cls: "lingua-hint",
            text: "The Lingua doctor tests both backends, AnkiConnect, "
                + "LinguaStudio's dependency doctor, and the card registry." });
        const dbtn = diag.createEl("button", { text: "Run Lingua doctor", cls: "mod-cta" });
        dbtn.addEventListener("click", () => this.plugin.runDoctor());
    }


    /* ----- Inbox support ----- */

    // A captured entry's richer values come from its vocab note's
    // frontmatter (traditional / zhuyin / image, or audio added after
    // capture); the entry's own values win (mergeNoteFields). No note —
    // createVocabNotes off, never saved, or the field absent — changes
    // nothing. Used when Inbox words move into a batch.
    enrichFromNotes(entries) {
        const folder = obsidian.normalizePath(this.plugin.settings.vocabNoteFolder);
        for (const e of entries) {
            if (!String(e.term || "").trim()) continue;
            const path = obsidian.normalizePath(vocabNotePath(folder, this.lang.vault, e.term));
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!file) continue;
            const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter;
            Object.assign(e, mergeNoteFields(e, fm));
        }
    }
}

/* ------------------------------------------------------------------ */
/* the sidebar                                                         */
/*                                                                     */
/* LINGUA · + (new batch) · ↻ (sync with Anki); the language menu; six */
/* tiles (Inbox, Review, Card Studio, New batch, Stats, Manage); then  */
/* the language's batches, the stacks, and the tools. Everything opens */
/* in the main view.                                                   */
/* ------------------------------------------------------------------ */

class LinguaNavView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.status = { vault: null, lingua: null };
        this.langOpen = false;
        this.langQ = "";
    }

    getViewType() { return NAV_VIEW; }
    getIcon() { return "languages"; }
    getDisplayText() { return "Lingua"; }

    async onOpen() {
        this.contentEl.addClass("lingua-v4-nav");
        this.plugin.requestBackendStart();
        this.registerDomEvent(this.contentEl.ownerDocument || document, "keydown", (e) => {
            if (e.key === "Escape" && this.langOpen) { this.langOpen = false; this.render(); }
        });
        this.render();
        this.refreshStatus();
    }

    async refreshStatus() {
        const probe = async (kind, base) => {
            try { return !!(await call(kind, base, "/health")); } catch (e) { return false; }
        };
        const s = this.plugin.settings;
        [this.status.vault, this.status.lingua] = await Promise.all([
            probe("vault", s.vaultSidecarUrl), probe("lingua", s.linguaSidecarUrl)]);
        this.render();
    }

    render() {
        const root = this.contentEl;
        const snap = lsSnapshot(root);
        root.empty();
        root.addClass("lingua-v4-nav");
        root.toggleClass("is-compact", this.plugin.settings.density === "compact");
        const lang = langByVault(this.plugin.activeLang());
        const mv = this.plugin.mainView();
        const at = mv ? { screen: mv.screen, batch: mv.screen === "batch" && mv.batch() ? mv.batch().id : null, stack: mv.screen === "stack" ? mv.stackId : null } : {};

        const head = root.createDiv({ cls: "lingua-nav-head" });
        head.createDiv({ cls: "lingua-kicker lingua-nav-brand", text: "Lingua" });
        const hb = head.createDiv({ cls: "lingua-row lingua-row-tight" });
        lsIconButton(hb, "plus", "New batch", () => this.plugin.openNewBatch());
        lsIconButton(hb, "refresh", "Sync with Anki", (e, btn) => this.plugin.syncAnki(btn));

        // language menu
        const lw = root.createDiv({ cls: "lingua-nav-lang" });
        const lb = lw.createEl("button", { cls: "lingua-lang-btn", attr: { "aria-haspopup": "listbox", "aria-expanded": this.langOpen ? "true" : "false" } });
        const lt = lb.createSpan({ cls: "lingua-lang-text" });
        lt.createSpan({ cls: "lingua-lang-name", text: lang.name });
        if (v4LangNative(lang.vault) && v4LangNative(lang.vault) !== lang.name) lt.createSpan({ cls: "lingua-muted", text: v4LangNative(lang.vault) });
        lsIcon(lb, "chevUpDown", 18);
        lb.addEventListener("click", () => { this.langOpen = !this.langOpen; this.langQ = ""; this.render(); });
        if (this.langOpen) {
            root.createDiv({ cls: "lingua-scrim" }).addEventListener("click", () => { this.langOpen = false; this.render(); });
            const pop = lw.createDiv({ cls: "lingua-pop lingua-lang-pop", attr: { role: "listbox" } });
            const q = lsInput(pop, this.langQ, { cls: "lingua-input", fkey: "nav-lang-q", placeholder: "Search languages", label: "Search languages",
                onInput: (v) => { this.langQ = v; this.render(); },
                onEnter: () => { const g = v4LangGroups(this.langQ); const first = g[0] && g[0].items[0]; if (first) this.pickLang(first.vault); } });
            const counts = {};
            for (const b of this.plugin.v4Store().batches) { const k = ocrBaseLang(b.lang || "zh"); counts[k] = (counts[k] || 0) + 1; }
            const listEl = pop.createDiv({ cls: "lingua-lang-list", attr: { "data-scroll": "nav-langs" } });
            for (const g of v4LangGroups(this.langQ)) {
                listEl.createDiv({ cls: "lingua-lang-group", text: g.label });
                for (const l of g.items) {
                    const on = l.vault === lang.vault;
                    const it = listEl.createEl("button", { cls: "lingua-lang-item" + (on ? " is-on" : ""), attr: { role: "option", "aria-selected": on ? "true" : "false" } });
                    it.createSpan({ cls: "lingua-accent", text: on ? "✓" : "" });
                    const nm = it.createSpan({ cls: "lingua-lang-item-name" });
                    nm.createSpan({ text: l.name });
                    const nat = v4LangNative(l.vault);
                    if (nat && nat !== l.name) nm.createSpan({ cls: "lingua-muted", text: nat });
                    const n = counts[ocrBaseLang(l.vault)];
                    it.createSpan({ cls: "lingua-muted lingua-small", text: n ? n + (n === 1 ? " batch" : " batches") : "" });
                    it.addEventListener("click", () => this.pickLang(l.vault));
                }
            }
            if (!snap.focus) window.setTimeout(() => q.focus(), 0);
        }

        const body = root.createDiv({ cls: "lingua-nav-body", attr: { "data-scroll": "nav" } });

        const grid = body.createDiv({ cls: "lingua-nav-grid" });
        const inboxN = this.plugin.pendingFor(lang.vault).length;
        const tiles = [
            ["inbox", "Inbox", "inbox", inboxN ? String(inboxN) : ""],
            ["review", "Review", "check", ""],
            ["studio", "Card Studio", "template", ""],
            ["new", "New batch", "plus", ""],
            ["stats", "Stats", "chart", ""],
            ["manage", "Manage", "gear", ""],
        ];
        for (const [id, label, icon, count] of tiles) {
            const t = grid.createEl("button", { cls: "lingua-nav-tile" + (at.screen === id ? " is-on" : "") });
            lsIcon(t.createSpan({ cls: "lingua-nav-tile-icon" }), icon, 20);
            t.createSpan({ cls: "lingua-nav-tile-label", text: label });
            if (count) t.createSpan({ cls: "lingua-nav-count", text: count });
            t.addEventListener("click", () => (id === "new" ? this.plugin.openNewBatch() : this.plugin.openMain({ screen: id })));
        }

        // batches
        const bs = body.createDiv({ cls: "lingua-nav-section" });
        const bh = bs.createDiv({ cls: "lingua-nav-section-head" });
        lsKicker(bh, "Batches");
        lsButton(bh, "New →", "link", () => this.plugin.openNewBatch());
        const batches = this.plugin.v4BatchesFor(lang.vault);
        for (const b of batches) {
            const s = v4Summary(b);
            const on = at.batch === b.id;
            const r = bs.createEl("button", { cls: "lingua-nav-row" + (on ? " is-on" : "") });
            lsIcon(r, "book", 22);
            const t = r.createDiv({ cls: "lingua-nav-row-text" });
            t.createDiv({ cls: "lingua-nav-row-label", text: b.name });
            t.createDiv({ cls: "lingua-nav-row-sub", text: `${s.words} word${s.words === 1 ? "" : "s"} · ${s.types} card type${s.types === 1 ? "" : "s"}` });
            r.createSpan({ cls: "lingua-nav-row-count" + (s.needN ? " is-warn" : ""), text: s.needN ? s.needN + " to check" : String(s.live) });
            r.addEventListener("click", () => this.plugin.openMain({ screen: "batch", batch: b.id }));
            r.addEventListener("contextmenu", (e) => { e.preventDefault(); this.batchMenu(e, b); });
        }
        if (!batches.length) bs.createDiv({ cls: "lingua-nav-empty", text: `No ${lang.name} batches yet.` });

        // stacks
        const ss = body.createDiv({ cls: "lingua-nav-section" });
        const sh = ss.createDiv({ cls: "lingua-nav-section-head" });
        lsKicker(sh, "Stacks");
        lsButton(sh, "New →", "link", async () => {
            const st = await this.plugin.v4AddStack("New stack", []);
            this.plugin.openMain({ screen: "stack", stack: st.id });
        });
        for (const st of this.plugin.v4Stacks()) {
            const n = v4StackSteps(st, this.plugin.v4Store().batches, this.plugin.settings.deckPrefix).steps.length;
            const r = ss.createEl("button", { cls: "lingua-nav-row is-compact" + (at.stack === st.id ? " is-on" : "") });
            lsIcon(r, "layers", 22);
            r.createDiv({ cls: "lingua-nav-row-text" }).createDiv({ cls: "lingua-nav-row-label", text: st.name });
            r.createSpan({ cls: "lingua-nav-row-count", text: n + (n === 1 ? " step" : " steps") });
            r.addEventListener("click", () => this.plugin.openMain({ screen: "stack", stack: st.id }));
        }
        if (!this.plugin.v4Stacks().length) ss.createDiv({ cls: "lingua-nav-empty", text: "Put batches in study order — one deck, numbered subdecks." });

        // tools
        const ts = body.createDiv({ cls: "lingua-nav-section" });
        lsKicker(ts.createDiv({ cls: "lingua-nav-section-head" }), "Tools");
        for (const [id, label, icon] of [["dictionary", "Dictionary", "dictionary"], ["sentences", "Sentences", "quote"],
            ["builders", "Builders", "wrench"], ["tools", "Import & OCR", "scan"]]) {
            const r = ts.createEl("button", { cls: "lingua-nav-row is-compact" + (at.screen === id ? " is-on" : "") });
            lsIcon(r, icon, 22);
            r.createDiv({ cls: "lingua-nav-row-text" }).createDiv({ cls: "lingua-nav-row-label", text: label });
            r.addEventListener("click", () => this.plugin.openMain({ screen: id, builderType: id === "builders" ? null : undefined }));
        }

        // backends
        const foot = root.createDiv({ cls: "lingua-nav-foot" });
        const dot = (label, state, hint) => {
            const d = foot.createSpan({ cls: "lingua-status", attr: { title: hint } });
            d.createSpan({ cls: "lingua-status-dot " + (state === null ? "is-unknown" : state ? "is-up" : "is-down") });
            d.createSpan({ text: label });
        };
        dot("vault", this.status.vault, "Vault sidecar · " + this.plugin.settings.vaultSidecarUrl);
        dot("engine", this.status.lingua, "LinguaStudio engine · " + this.plugin.settings.linguaSidecarUrl);
        lsButton(foot, "recheck", "link push-right", () => this.refreshStatus());
        lsIconButton(foot, "gear", "Lingua doctor", () => this.plugin.runDoctor(), 18);

        lsRestore(root, snap);
    }

    async pickLang(code) {
        this.langOpen = false;
        this.langQ = "";
        await this.plugin.setActiveLang(code);
        this.render();
    }

    batchMenu(evt, b) {
        const menu = new obsidian.Menu();
        menu.addItem((i) => i.setTitle("Open").setIcon("book-open").onClick(() => this.plugin.openMain({ screen: "batch", batch: b.id })));
        menu.addItem((i) => i.setTitle("Skim cards").setIcon("eye").onClick(() => this.plugin.openMain({ screen: "batch", batch: b.id, tab: "skim" })));
        menu.addItem((i) => i.setTitle("Duplicate").setIcon("copy").onClick(async () => {
            const copy = await this.plugin.v4Duplicate(b.id);
            if (copy) this.plugin.openMain({ screen: "batch", batch: copy.id });
        }));
        menu.addSeparator();
        menu.addItem((i) => i.setTitle("Delete batch…").setIcon("trash-2").onClick(() => this.plugin.confirmDeleteBatch(b.id)));
        menu.showAtMouseEvent(evt);
    }
}

/* ------------------------------------------------------------------ */
/* doctor modal                                                        */
/* ------------------------------------------------------------------ */

class LinguaDoctorModal extends obsidian.Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.report = "Running…";
    }

    onOpen() {
        this.titleEl.setText("Lingua doctor");
        this.modalEl.addClass("lingua-modal");
        this.pre = this.contentEl.createEl("pre", { cls: "lingua-doctor", text: this.report });
        const row = this.contentEl.createDiv({ cls: "lingua-actions" });
        const copy = row.createEl("button", { text: "Copy report" });
        copy.addEventListener("click", () => {
            navigator.clipboard.writeText(this.report);
            new obsidian.Notice("Copied.");
        });
        this.run();
    }

    line(s) {
        this.report = this.report === "Running…" ? s : this.report + "\n" + s;
        this.pre.setText(this.report);
    }

    async run() {
        const s = this.plugin.settings;
        const tryStep = async (label, fn, fix) => {
            try {
                const detail = await fn();
                this.line(`ok    ${label}` + (detail ? ` — ${detail}` : ""));
            } catch (e) {
                this.line(`FAIL  ${label} — ${e.message || e}`);
                if (fix) this.line(`      fix: ${fix}`);
            }
        };
        await tryStep(`vault sidecar (${s.vaultSidecarUrl})`,
            async () => { await call("vault", s.vaultSidecarUrl, "/health"); },
            "cd sidecar && .venv/bin/uvicorn app.main:app --port 8749");
        await tryStep(`LinguaStudio engine (${s.linguaSidecarUrl})`,
            async () => {
                const r = await call("lingua", s.linguaSidecarUrl, "/health");
                return r && r.version ? `v${r.version}` : "";
            },
            "auto-starts with the workspace; set lingua_repo in Vault Sidecar settings");
        await tryStep(`AnkiConnect (${s.ankiConnectUrl})`,
            async () => {
                const r = await call("anki", s.ankiConnectUrl, "",
                    { action: "version", version: 6 });
                return r && r.result ? `API v${r.result}` : "";
            },
            "open Anki with the AnkiConnect add-on (2055492159)");
        await tryStep("LinguaStudio dependency doctor",
            async () => {
                const r = await call("lingua", s.linguaSidecarUrl, "/doctor");
                if (!r || !Array.isArray(r.checks)) return "no report";
                const bad = r.checks.filter((c) => c && c.status && c.status !== "ok");
                if (bad.length) {
                    throw new Error(bad.map((c) => `${c.name}: ${c.status}`).join("; "));
                }
                return `${r.checks.length} checks green`;
            },
            "run `python3 sidecar/doctor.py` in lingua-studio for repair guidance");
        await tryStep("card registry",
            async () => {
                const n = Object.keys(CARD_REGISTRY.specs).length;
                if (n < 30) throw new Error(`only ${n} builders — regenerate the registry`);
                return `${n} builders, matching the app's nav`;
            },
            "node tools/extract-specs.js <lingua-studio path>");
        this.line("");
        this.line("Capture, TTS, and the vocab .apkg export all run through the "
            + "vault sidecar now; dictionary, cloze, card-builder export, OCR, "
            + "images, and the Anki push still need the LinguaStudio engine. An "
            + "inventory-driven vocab export needs both — LinguaStudio to look "
            + "the term up, the vault sidecar to build the .apkg.");
    }
}

/* ------------------------------------------------------------------ */
/* Relate modal — link a word to another saved term (spec §10, Stage 9) */
/* ------------------------------------------------------------------ */

const RELATE_FAMILIES = [
    { value: "synonyms", label: "Synonyms" },
    { value: "derived_from", label: "Derived from" },
    { value: "contrasts", label: "Contrasts" },
    { value: "collocates", label: "Collocates" },
];

/* One word, one family, one other term already in the SAME language's CSV.
   relate() refuses a term that is not on record, so the target is chosen by
   autocomplete over the language's own saved terms rather than free text —
   the only input that can always succeed, and the reason this never creates a
   dangling edge a relationship canvas would draw to nowhere. Existing
   relations are listed per family; clicking one removes it (relate add=false).
   Rows are fetched fresh on open and after every mutation, so the list never
   shows a stale copy of the CSV. */
class RelateModal extends obsidian.Modal {
    constructor(app, plugin, langVault, word) {
        super(app);
        this.plugin = plugin;
        this.langVault = langVault;
        this.word = word;
        this.rows = [];
        this.family = "synonyms";
    }

    onOpen() {
        this.titleEl.setText(`Relate ${this.word}`);
        this.modalEl.addClass("lingua-modal");
        this.contentEl.addClass("lingua-relate");
        this.contentEl.createDiv({ cls: "lingua-muted", text: "Loading…" });
        this.load();
    }

    async load() {
        try {
            // Fresh rows on open and after every write: the CSV is the
            // source of truth for relations.
            const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                `/vocab/rows?lang=${encodeURIComponent(this.langVault)}&enrich=1`);
            this.rows = (r && r.rows) || [];
        } catch (e) {
            this.rows = [];
        }
        this.render();
    }

    render() {
        const el = this.contentEl;
        el.empty();
        if (!this.rows.some((row) => row.term === this.word)) {
            el.createDiv({ cls: "lingua-empty", text:
                `${this.word} is not in the vocabulary record yet — words are recorded when `
                + "they're added to a batch with the vault sidecar running." });
            return;
        }

        const famRow = el.createDiv({ cls: "lingua-form" });
        const famWrap = famRow.createDiv({ cls: "lingua-field" });
        famWrap.createEl("label", { text: "Family" });
        const fam = famWrap.createEl("select");
        for (const f of RELATE_FAMILIES) {
            fam.createEl("option", { value: f.value, text: f.label });
        }
        fam.value = this.family;
        fam.addEventListener("change", () => { this.family = fam.value; });

        const tWrap = famRow.createDiv({ cls: "lingua-field lingua-relate-target" });
        tWrap.createEl("label", { text: "Relate to" });
        const input = tWrap.createEl("input", {
            attr: { type: "text", placeholder: "type to search saved terms…" } });
        const box = tWrap.createDiv({ cls: "lingua-relate-suggest" });
        const candidates = this.rows.map((row) => row.term).filter((t) => t !== this.word);
        input.addEventListener("input", () => {
            box.empty();
            const q = input.value.trim().toLowerCase();
            if (!q) return;
            for (const t of candidates) {
                if (!t.toLowerCase().includes(q)) continue;
                if (box.children.length >= 12) break;
                const item = box.createDiv({ cls: "lingua-relate-suggest-item", text: t });
                item.addEventListener("click", () => { input.value = t; box.empty(); });
            }
        });
        const add = famRow.createEl("button", { text: "Add relation", cls: "mod-cta" });
        add.addEventListener("click", () => this.plugin.withOp("adding relation", async () => {
            const target = input.value.trim();
            if (!target || target === this.word) {
                new obsidian.Notice("Pick a different saved term.");
                return;
            }
            await call("vault", this.plugin.settings.vaultSidecarUrl, "/vocab/relate",
                { lang: this.langVault, a: this.word, b: target,
                    family: this.family, add: true });
            await this.load();
        }, add));

        const me = this.rows.find((row) => row.term === this.word) || {};
        for (const f of RELATE_FAMILIES) {
            const cur = me[f.value] || [];
            const block = el.createDiv({ cls: "lingua-relate-family" });
            block.createEl("h4", { text: f.label });
            if (!cur.length) {
                block.createDiv({ cls: "lingua-hint", text: "none yet" });
                continue;
            }
            const chips = block.createDiv({ cls: "lingua-chip-row" });
            for (const t of cur) {
                const chip = chips.createEl("button", {
                    cls: "lingua-chip", text: `${t} ×`,
                    attr: { title: "Remove this relation" } });
                chip.addEventListener("click", () => this.plugin.withOp("removing relation",
                    async () => {
                        await call("vault", this.plugin.settings.vaultSidecarUrl,
                            "/vocab/relate", { lang: this.langVault, a: this.word,
                                b: t, family: f.value, add: false });
                        await this.load();
                    }, chip));
            }
        }
    }

}

/* ------------------------------------------------------------------ */
/* New batch — where are the words coming from?                        */
/*                                                                     */
/* Five sources, each a short second step that ends in a word list:    */
/* paste; a frequency list (the engine's dictionary, HSK-filtered for  */
/* Mandarin); the Inbox and the inventory's words not yet in Anki;     */
/* Boox / photo highlights (OCR — flagged for a check); an Anki deck   */
/* (AnkiConnect). Card types, themes and rules come after.             */
/* ------------------------------------------------------------------ */

const V4_SOURCES = [
    ["paste", "Paste or type", "One word per line, or separated by spaces"],
    ["freq", "Frequency list", "HSK 1–6, TOCFL, or the dictionary's most frequent words"],
    ["vault", "From vault notes", "Words captured in your notes and the Inbox"],
    ["ocr", "Boox / photo highlights", "Highlights are read with OCR — low-confidence ones get flagged"],
    ["anki", "Existing Anki deck", "Import notes and rebuild them with new card types"],
];

class NewBatchModal extends obsidian.Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.lang = langByVault(plugin.activeLang());
        this.source = null;
        this.name = "";
        this.text = "";
        this.found = [];      // [{term, reading, gloss, conf, src, pick, pendingIndex?}]
        this.busy = false;
        this.error = "";
        this.hsk = "1";
        this.freqQ = "";
        this.decks = null;
        this.deck = "";
    }

    onOpen() {
        this.modalEl.addClass("lingua-modal", "lingua-newbatch");
        this.render();
    }

    render() {
        const el = this.contentEl;
        const snap = lsSnapshot(el);
        el.empty();
        this.titleEl.setText(this.source ? "New batch — " + V4_SOURCES.find((s) => s[0] === this.source)[1]
            : "New batch — where are the words coming from?");
        if (!this.source) {
            const list = el.createDiv({ cls: "lingua-source-list" });
            for (const [id, name, desc] of V4_SOURCES) {
                const b = list.createEl("button", { cls: "lingua-source" });
                b.createDiv({ cls: "lingua-source-name", text: name });
                b.createDiv({ cls: "lingua-muted", text: desc });
                b.addEventListener("click", () => this.pick(id));
            }
            el.createDiv({ cls: "lingua-modal-foot", text: `${this.lang.name} · card types, themes and rules are set after the words are in. Esc to dismiss.` });
            return;
        }
        const body = el.createDiv({ cls: "lingua-source-body" });
        lsButton(body, "← All sources", "link", () => { this.source = null; this.found = []; this.error = ""; this.render(); });
        const nm = body.createEl("label", { cls: "lingua-field" });
        nm.createSpan({ cls: "lingua-muted", text: "Batch name" });
        lsInput(nm, this.name, { fkey: "nb-name", label: "Batch name", onInput: (v) => { this.name = v; } });
        this["source_" + this.source](body);
        if (this.error) body.createDiv({ cls: "lingua-error", text: this.error });
        const words = this.words();
        const foot = el.createDiv({ cls: "lingua-modal-actions" });
        foot.createSpan({ cls: "lingua-muted push-right", text: words.length ? `${words.length} word${words.length === 1 ? "" : "s"}` : "" });
        lsButton(foot, "Cancel", "", () => this.close());
        const go = lsButton(foot, "Create batch", "cta", () => this.create());
        go.disabled = !words.length || this.busy;
        lsRestore(el, snap);
    }

    pick(id) {
        this.source = id;
        const today = new Date().toISOString().slice(0, 10);
        this.name = { paste: "New batch", freq: isMandarinLang(this.lang.vault) ? "HSK " + this.hsk : this.lang.name + " · frequent",
            vault: "From notes · " + today, ocr: "Highlights · " + today, anki: "From Anki" }[id];
        if (id === "vault") this.loadVault();
        if (id === "anki") this.loadDecks();
        this.render();
    }

    /* The chosen words, in order, deduplicated. */
    words() {
        if (this.source === "paste") return v4SplitWords(this.text).map((term) => ({ term }));
        const seen = new Set();
        return this.found.filter((f) => f.pick && !seen.has(f.term) && seen.add(f.term));
    }

    foundList(el, empty) {
        if (!this.found.length) { el.createDiv({ cls: "lingua-muted", text: this.busy ? "Loading…" : empty }); return; }
        const all = this.found.every((f) => f.pick);
        const bar = el.createDiv({ cls: "lingua-row" });
        lsButton(bar, all ? "Select none" : "Select all", "small", () => { this.found.forEach((f) => { f.pick = !all; }); this.render(); });
        const list = el.createDiv({ cls: "lingua-found", attr: { "data-scroll": "nb-found" } });
        this.found.forEach((f) => {
            const r = list.createEl("button", { cls: "lingua-found-row" + (f.pick ? " is-sel" : "") });
            lsCheck(r, !!f.pick);
            r.createSpan({ cls: "lingua-found-term", text: f.term, attr: { dir: "auto" } });
            r.createSpan({ cls: "lingua-muted", text: [f.reading, f.gloss].filter(Boolean).join(" · ") });
            if (f.conf != null && f.conf < 0.8) r.createSpan({ cls: "lingua-flag", text: "check" });
            r.addEventListener("click", () => { f.pick = !f.pick; this.render(); });
        });
    }

    source_paste(el) {
        const ta = lsInput(el, this.text, { multiline: true, rows: 8, cls: "lingua-input lingua-textarea", fkey: "nb-text", dir: "auto",
            placeholder: isMandarinLang(this.lang.vault) ? "苹果\n香蕉 葡萄、西瓜" : "one word per line, or separated by spaces",
            onInput: (v) => { this.text = v; this.renderSoon(); } });
        ta.setAttribute("aria-label", "Words");
    }

    renderSoon() {
        window.clearTimeout(this._t);
        this._t = window.setTimeout(() => this.render(), 250);
    }

    source_freq(el) {
        const zh = isMandarinLang(this.lang.vault);
        const row = el.createDiv({ cls: "lingua-row lingua-row-wrap" });
        if (zh) {
            lsSelect(row, this.hsk, [1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: String(n), label: n === 7 ? "HSK 7–9" : "HSK " + n })),
                (v) => { this.hsk = v; this.name = v === "7" ? "HSK 7–9" : "HSK " + v; this.render(); });
        } else {
            lsInput(row, this.freqQ, { cls: "lingua-input", fkey: "nb-freq", placeholder: "filter (optional)", label: "Filter", onInput: (v) => { this.freqQ = v; } });
        }
        const load = lsButton(row, this.found.length ? "Reload" : "Load list", "", () => this.loadFreq(load));
        this.foundList(el, zh ? "Pick a level and load it from the dictionary." : "Loads the dictionary's most frequent words.");
    }

    async loadFreq(btn) {
        this.busy = true; this.error = ""; this.render();
        const zh = isMandarinLang(this.lang.vault);
        try {
            const r = await call("lingua", this.plugin.settings.linguaSidecarUrl, "/dict/search", {
                query: zh ? "" : this.freqQ.trim(), lang: this.lang.lingua, limit: 150, offset: 0,
                sort: zh ? "hsk" : "freq", hsk_level: zh ? parseInt(this.hsk, 10) : 0 });
            if (!r || r.ok === false) throw new Error((r && r.error) || "The dictionary answered nothing.");
            this.found = (r.results || []).map((x) => ({ term: x.word || "", reading: x.trans || "", gloss: x.meaning || "", pick: true }))
                .filter((x) => x.term);
            if (!this.found.length) this.error = "No words came back — is a dictionary installed for " + this.lang.name + "? (Manage → Languages)";
        } catch (e) { this.error = String(e.message || e); }
        this.busy = false;
        this.render();
    }

    async loadVault() {
        const pending = this.plugin.pendingFor(this.lang.vault);
        this.found = pending.map((e, i) => ({ term: e.term, reading: e.reading || "", gloss: e.gloss || "", src: e.source || "Inbox", pick: true, pendingIndex: i }));
        this.busy = true; this.render();
        try {
            const path = `${this.plugin.settings.generatedFolder}/Language Inventory — ${this.lang.vault}.md`;
            const f = this.app.vault.getAbstractFileByPath(obsidian.normalizePath(path));
            if (f) {
                const have = new Set(this.found.map((x) => x.term));
                for (const t of parseInventoryUnexported(await this.app.vault.cachedRead(f))) {
                    if (!have.has(t)) this.found.push({ term: t, reading: "", gloss: "", src: "Notes", pick: false });
                }
            }
        } catch (e) { this.error = String(e.message || e); }
        this.busy = false;
        this.render();
    }

    source_vault(el) {
        el.createDiv({ cls: "lingua-muted lingua-small", text: "Inbox words are ticked; words from your notes that aren't in Anki yet (the inventory) are listed below them." });
        this.foundList(el, "Nothing captured yet — the Inbox is empty and the inventory has no new words.");
    }

    source_ocr(el) {
        const row = el.createDiv({ cls: "lingua-row lingua-row-wrap" });
        const file = row.createEl("input", { attr: { type: "file", accept: "image/*", "aria-label": "Image" } });
        const go = lsButton(row, "Read highlights", "", async () => {
            const f = file.files && file.files[0];
            if (!f) { this.error = "Pick an image first."; this.render(); return; }
            this.busy = true; this.error = ""; this.render();
            try {
                const bytes = new Uint8Array(await f.arrayBuffer());
                const r = await call("vault", this.plugin.settings.vaultSidecarUrl, "/ocr",
                    { images: [bytesToBase64(bytes)], lang: ocrPackFor(this.lang.vault) });
                const lines = String((r && r.text) || "").split("\n").map((s) => s.trim()).filter(Boolean);
                const terms = [];
                for (const line of lines) terms.push(...v4SplitWords(line));
                this.found = terms.map((t) => ({ term: t, conf: 0.7, src: "Boox", pick: true }));
                if (!this.found.length) this.error = "No text found in that image.";
            } catch (e) { this.error = String(e.message || e); }
            this.busy = false;
            this.render();
        });
        go.disabled = this.busy;
        el.createDiv({ cls: "lingua-muted lingua-small", text: `Read with the ${ocrPackFor(this.lang.vault)} OCR pack. Every word is flagged “Check capture” until you confirm it.` });
        this.foundList(el, "A screenshot or photo of highlighted words.");
    }

    async loadDecks() {
        this.busy = true; this.render();
        try {
            const r = await call("anki", this.plugin.settings.ankiConnectUrl, "", { action: "deckNames", version: 6 });
            if (r && r.error) throw new Error(r.error);
            this.decks = ((r && r.result) || []).sort();
        } catch (e) { this.error = String(e.message || e); this.decks = []; }
        this.busy = false;
        this.render();
    }

    source_anki(el) {
        if (!this.decks) { el.createDiv({ cls: "lingua-muted", text: "Asking Anki for its decks…" }); return; }
        const row = el.createDiv({ cls: "lingua-row lingua-row-wrap" });
        lsSelect(row, this.deck, [{ value: "", label: "Choose a deck…" }, ...this.decks.map((d) => ({ value: d }))],
            (v) => { this.deck = v; this.name = v.split("::").pop(); this.loadDeck(); });
        this.foundList(el, this.deck ? "" : "The first field of each note becomes a word.");
    }

    async loadDeck() {
        if (!this.deck) return;
        this.busy = true; this.error = ""; this.found = []; this.render();
        const url = this.plugin.settings.ankiConnectUrl;
        try {
            const ids = await call("anki", url, "", { action: "findNotes", version: 6, params: { query: `deck:"${this.deck.replace(/"/g, '\\"')}"` } });
            if (ids && ids.error) throw new Error(ids.error);
            const noteIds = ((ids && ids.result) || []).slice(0, 500);
            const info = noteIds.length ? await call("anki", url, "", { action: "notesInfo", version: 6, params: { notes: noteIds } }) : { result: [] };
            if (info && info.error) throw new Error(info.error);
            const strip = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/\[sound:[^\]]*\]/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
            this.found = ((info && info.result) || []).map((n) => {
                const fields = Object.values(n.fields || {}).sort((a, b) => a.order - b.order).map((f) => strip(f.value));
                return { term: fields[0] || "", reading: "", gloss: "", src: "Anki", pick: true };
            }).filter((x) => x.term && x.term.length <= 40);
            if (!this.found.length) this.error = "That deck has no notes with a short first field.";
        } catch (e) { this.error = String(e.message || e); }
        this.busy = false;
        this.render();
    }

    async create() {
        const words = this.words();
        if (!words.length) return;
        const src = V4_SOURCES.find((s) => s[0] === this.source)[1];
        const zh = isMandarinLang(this.lang.vault);
        const b = v4NewBatch(this.name.trim() || "New batch", this.lang.vault, src);
        b.deck = `${this.plugin.settings.deckPrefix}::${this.lang.name}::${(this.name.trim() || "New batch").replace(/::/g, " ")}`;
        b.words = words.map((f) => v4MakeWord(f.term, {
            P: zh ? v4PinyinMarks(f.reading || "") : (f.reading || ""),
            src: f.src || (this.source === "paste" ? "Typed" : src),
            conf: f.conf == null ? 1 : f.conf,
        }));
        // Dictionary glosses go through the same sense parsing as a lookup.
        b.words.forEach((w, i) => {
            const g = words[i].gloss;
            if (g) Object.assign(w, v4MeaningFromSenses(v4ParseGloss(g).senses));
            if (zh && w.P) w.Z = v4Zhuyin(w.P);
        });
        await this.plugin.v4Add(b);
        if (this.source === "vault") {
            const idx = words.filter((f) => f.pendingIndex != null).map((f) => f.pendingIndex).sort((a, c) => c - a);
            for (const i of idx) await this.plugin.removePending(this.lang.vault, i);
        }
        this.close();
        const view = await this.plugin.openMain({ screen: "batch", batch: b.id, tab: "words" });
        if (view) {
            for (const w of b.words) {
                call("vault", this.plugin.settings.vaultSidecarUrl, "/vocab/upsert", { lang: b.lang, row: { term: w.S } }).catch(() => {});
            }
            view.enrichNewWords(b.id, b.words.map((w) => w.id));
        }
    }
}

/* ------------------------------------------------------------------ */
/* Find an image for a word (Visual cards)                             */
/* ------------------------------------------------------------------ */

class ImagePickModal extends obsidian.Modal {
    constructor(app, plugin, word, meaning, onPick) {
        super(app);
        this.plugin = plugin;
        this.word = word;
        this.meaning = meaning || "";
        this.onPick = onPick;
        this.results = null;
        this.error = "";
    }

    onOpen() {
        this.modalEl.addClass("lingua-modal");
        this.titleEl.setText("An image for " + this.word);
        this.search();
    }

    async search() {
        this.render();
        try {
            const r = await call("lingua", this.plugin.settings.linguaSidecarUrl, "/images/search",
                { word: this.word, meaning: this.meaning, maxResults: 12 });
            if (!r || r.ok === false) throw new Error((r && r.error) || "Search failed.");
            this.results = r.results || [];
        } catch (e) { this.error = String(e.message || e); this.results = []; }
        this.render();
    }

    render() {
        const el = this.contentEl;
        el.empty();
        if (this.error) el.createDiv({ cls: "lingua-error", text: this.error });
        if (this.results === null) { el.createDiv({ cls: "lingua-muted", text: "Searching…" }); return; }
        if (!this.results.length) { el.createDiv({ cls: "lingua-muted", text: "No pictures found." }); return; }
        const grid = el.createDiv({ cls: "lingua-img-grid" });
        for (const res of this.results) {
            const cell = grid.createEl("button", { cls: "lingua-img-cell", attr: { title: (res.source || "") + " — use this picture" } });
            if (res.thumbB64 || res.thumb) cell.createEl("img", { attr: { alt: res.title || this.word, src: res.thumbB64 ? `data:image/jpeg;base64,${res.thumbB64}` : res.thumb } });
            else cell.setText(res.title || "image");
            cell.addEventListener("click", () => this.plugin.withOp("fetching image", async () => {
                const r = await call("lingua", this.plugin.settings.linguaSidecarUrl, "/images/fetch",
                    { url: res.url, word: this.word, source: res.source || "", license: res.license || "", credit: res.credit || "" });
                if (!r || r.ok === false || !r.filename) throw new Error((r && r.error) || "Fetch failed.");
                this.onPick(r.filename);
                new obsidian.Notice(`Image set: ${r.filename}`);
                this.close();
            }));
        }
    }
}

/* ------------------------------------------------------------------ */
/* the plugin                                                          */
/* ------------------------------------------------------------------ */

class LinguaWorkspacePlugin extends obsidian.Plugin {
    async onload() {
        const data = await this.loadData() || {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
        this.data = {
            pending: data.pending || {},
            batches: data.batches || {},
            vocab: data.vocab || {},          // per-language { terms: [], selected: [] } — see _vocab()
            activeLang: data.activeLang || this.settings.defaultLang,
            v4: data.v4 || { batches: [], cur: null, stacks: [] },  // v4 word batches + stacks — see v4Store()
        };
        this.ops = new Map();
        this.hadViews = false;

        await this.migrateVocabListsToBatches();

        this.registerView(MAIN_VIEW, (leaf) => new LinguaMainView(leaf, this));
        this.registerView(NAV_VIEW, (leaf) => new LinguaNavView(leaf, this));

        // Heartbeat while any Lingua view exists OR any operation is still
        // running — an in-flight export must never lose its engine to the
        // idle reaper just because the workspace closed.
        this.registerInterval(window.setInterval(() => {
            if (this.viewCount() > 0 || this.ops.size > 0) {
                this.serviceCall("keepalive");
            }
        }, KEEPALIVE_MS));

        // Leaving the workspace (views destroyed) with work still running:
        // say so — the operations may be canceled.
        this.registerEvent(this.app.workspace.on("layout-change", () => {
            const now = this.viewCount() > 0;
            if (this.hadViews && !now && this.ops.size > 0) {
                new obsidian.Notice(
                    `Lingua: ${this.ops.size} operation(s) still running — `
                    + `${this.opLabels().join(", ")}. Leaving the workspace `
                    + "may cancel them; results that finish will still be "
                    + "saved.", 10000);
            }
            this.hadViews = now;
        }));

        this.addRibbonIcon("languages", "Open Lingua workspace", () => this.openWorkspace());
        this.addCommand({ id: "open-lingua-workspace", name: "Open Lingua workspace",
            callback: () => this.openWorkspace() });
        this.addCommand({ id: "open-lingua-workbench", name: "Open Lingua workbench",
            callback: () => this.openMain() });
        this.addCommand({ id: "lingua-new-batch", name: "New Lingua batch",
            callback: () => this.openNewBatch() });
        this.addCommand({ id: "lingua-doctor", name: "Lingua doctor",
            callback: () => this.runDoctor() });
        this.addSettingTab(new LinguaSettingTab(this.app, this));

        this.app.workspace.onLayoutReady(() => {
            this.hadViews = this.viewCount() > 0;
            this.ensureWorkspaces(false);
        });
    }

    /* The 15-tab layout's Vocab builder kept one word list per language
       (data.vocab[lang].terms). The batches replace it; a list that still
       holds words becomes a batch once — "Vocabulary · <language>", same
       templates — so nothing typed there is stranded. The old list is kept
       (flagged), and the words are looked up when the batch is opened and
       filled (Fill column → Meanings). */
    async migrateVocabListsToBatches() {
        let changed = false;
        for (const [code, v] of Object.entries(this.data.vocab || {})) {
            if (!v || v.migratedToV4) continue;
            const terms = Array.isArray(v.terms) ? v.terms
                : Array.isArray(v.words) ? v.words.map((w) => w && w.word).filter(Boolean) : [];
            if (terms.length) {
                const lang = langByVault(code);
                const b = v4NewBatch("Vocabulary · " + lang.name, code, "Vocab builder");
                b.deck = `${this.settings.deckPrefix}::${lang.name}`;
                b.words = [...new Set(terms)].map((t) => v4MakeWord(t, { src: "Vocab builder" }));
                const sel = (v.selected || []).filter((t) => VOCAB_BASE_TEMPLATES.includes(t));
                if (b.outs[0].type === "vocab" && sel.length) b.outs[0].tpls = sel.map((t) => VOCAB_BASE_TEMPLATES.indexOf(t)).sort((x, y) => x - y);
                this.v4Store().batches.push(b);
            }
            v.migratedToV4 = true;
            changed = true;
        }
        if (changed) await this.persist();
    }

    viewCount() {
        return this.app.workspace.getLeavesOfType(MAIN_VIEW).length
            + this.app.workspace.getLeavesOfType(NAV_VIEW).length;
    }

    async persist() {
        await this.saveData({ settings: this.settings, pending: this.data.pending,
            batches: this.data.batches, vocab: this.data.vocab,
            activeLang: this.data.activeLang, v4: this.data.v4 });
    }

    async saveSettings() { await this.persist(); }

    /* ----- vocab batch (per language, persisted) -------------------------
     * spec §10 rewrite. The vocabulary itself — term, reading, gloss, audio,
     * image — lives in the sidecar's per-language CSV now (vault sidecar,
     * `08 Meta/Study/Vocabulary — <bucket>.csv`), not here. What stays here
     * is a thin, LOCAL selection of terms: which words are currently loaded
     * into this Anki-card-building batch. That distinction matters — the CSV
     * is shared, persistent, tracked vocabulary that reading-companion's
     * coverage and the practice ledger depend on; "Remove" and "Clear" in
     * this view are batch actions ("take this out of the cards I'm about to
     * push"), not vocabulary deletion, and must never touch the CSV row. Only
     * "Add" writes to the CSV (an upsert, so it is safe to add a term that is
     * already tracked — merge, not duplicate).
     *
     * `words` (an array of {word, trans, meaning, traditional, zhuyin, audio,
     * image} objects, looked up via the LinguaStudio sidecar's now-dead
     * /vocab/lookup on :8000) is replaced by `terms` (an array of plain term
     * strings). trans/meaning/traditional/zhuyin were dictionary content
     * anyway — the CSV design drops exactly those fields, joining
     * reading/gloss from the offline dictionary at READ time instead
     * (3.4's enrich_vocab_rows) so they can never go stale.
     */

    _vocab(vaultCode) {
        const v = this.data.vocab[vaultCode] = this.data.vocab[vaultCode]
            || { terms: [], selected: [...VOCAB_BASE_TEMPLATES] };
        // Migrate a legacy `.words` array in place, once. This is pure
        // (no network) — it only reshapes what was already on disk, so it is
        // safe to run synchronously on every access rather than gating it
        // behind a load-time flag. The actual CSV upsert for any words this
        // uncovers is a separate, explicit, async step (migrateVocabToCsv)
        // that the UI drives — this function must not silently drop words
        // that were never pushed to the CSV by returning an empty `.terms`.
        if (Array.isArray(v.words)) {
            const legacyTerms = v.words.map((w) => w && w.word).filter(Boolean);
            v.terms = Array.from(new Set([...(v.terms || []), ...legacyTerms]));
            v._legacyWords = v.words;   // kept until migrateVocabToCsv confirms the upsert
            delete v.words;
        }
        if (!Array.isArray(v.terms)) v.terms = [];
        return v;
    }

    vocabTermsFor(vaultCode) {
        return this._vocab(vaultCode).terms;
    }

    vocabSelected(vaultCode) {
        const v = this._vocab(vaultCode);
        return (v.selected && v.selected.length) ? v.selected : [...VOCAB_BASE_TEMPLATES];
    }

    async setVocabSelected(vaultCode, list) {
        this._vocab(vaultCode).selected = list.length ? list : [...VOCAB_BASE_TEMPLATES];
        await this.persist();
    }

    // Ensure `word` is both a CSV row (upsert — merge, never duplicate) and
    // in this batch's local selection. Returns the created/merged row so the
    // caller can render it immediately without a second round trip.
    async addVocabTerm(vaultCode, word) {
        let row = null;
        try {
            const r = await call("vault", this.settings.vaultSidecarUrl, "/vocab/upsert",
                { lang: vaultCode, row: { term: word } });
            row = r && r.row;
        } catch (e) { /* offline — still add to the local batch; upsert retries on next add */ }
        const v = this._vocab(vaultCode);
        if (!v.terms.includes(word)) v.terms.push(word);
        await this.persist();
        return row;
    }

    async removeVocabTerm(vaultCode, word) {
        const v = this._vocab(vaultCode);
        v.terms = v.terms.filter((t) => t !== word);
        await this.persist();
    }

    async clearVocab(vaultCode) {
        this._vocab(vaultCode).terms = [];
        await this.persist();
    }

    // One-time, per-language: push every legacy word object's term (+ audio/
    // image, the two fields the CSV still owns) into the sidecar CSV, then
    // drop `_legacyWords`. Explicit and async — called by the view, not by
    // `_vocab()`, because it needs the sidecar reachable and must report
    // failure rather than silently losing words offline.
    async migrateVocabToCsv(vaultCode) {
        const v = this._vocab(vaultCode);
        const legacy = v._legacyWords;
        if (!legacy || !legacy.length) return { migrated: 0, failed: 0 };
        let migrated = 0, failed = 0;
        for (const w of legacy) {
            if (!w || !w.word) continue;
            try {
                const row = { term: w.word };
                if (w.audio) row.audio = w.audio;
                if (w.image) row.image = w.image;
                await call("vault", this.settings.vaultSidecarUrl, "/vocab/upsert",
                    { lang: vaultCode, row });
                migrated++;
            } catch (e) { failed++; }
        }
        if (failed === 0) {
            delete v._legacyWords;
            await this.persist();
        }
        return { migrated, failed };
    }

    /* ----- tracked operations ----- */

    opLabels() {
        return [...this.ops.values()];
    }

    refreshBusyChips() {
        for (const leaf of this.app.workspace.getLeavesOfType(MAIN_VIEW)) {
            if (leaf.view instanceof LinguaMainView) leaf.view.refreshBusy();
        }
    }

    // The sidebar shows counts and the active row — redraw it after any
    // change the main view makes.
    refreshNav() {
        // Coalesced: a run of lookups changes the counts word by word.
        if (this._navT) return;
        this._navT = window.setTimeout(() => {
            this._navT = null;
            for (const leaf of this.app.workspace.getLeavesOfType(NAV_VIEW)) {
                if (leaf.view instanceof LinguaNavView) leaf.view.render();
            }
        }, 40);
    }

    mainView() {
        for (const leaf of this.app.workspace.getLeavesOfType(MAIN_VIEW)) {
            if (leaf.view instanceof LinguaMainView) return leaf.view;
        }
        return null;
    }

    rerenderViews() {
        for (const leaf of this.app.workspace.getLeavesOfType(MAIN_VIEW)) {
            if (leaf.view instanceof LinguaMainView) leaf.view.render();
        }
        for (const leaf of this.app.workspace.getLeavesOfType(NAV_VIEW)) {
            if (leaf.view instanceof LinguaNavView) leaf.view.render();
        }
    }

    // Run an async job as a tracked operation: busy chip while it runs,
    // keepalive kept warm, button disabled, errors surfaced as notices.
    async withOp(label, fn, btn) {
        const id = uid();
        this.ops.set(id, label);
        this.refreshBusyChips();
        if (btn) btn.disabled = true;
        this.serviceCall("keepalive");
        try {
            return await fn();
        } catch (e) {
            new obsidian.Notice(String(e.message || e), 8000);
        } finally {
            this.ops.delete(id);
            if (btn) btn.disabled = false;
            this.refreshBusyChips();
        }
    }

    /* ----- pending vocab (per language) ----- */

    pendingFor(vaultCode) {
        return this.data.pending[vaultCode] || [];
    }

    async addPending(vaultCode, entry) {
        const list = this.data.pending[vaultCode] = this.data.pending[vaultCode] || [];
        list.push(entry);
        await this.persist();
    }

    async removePending(vaultCode, index) {
        const list = this.data.pending[vaultCode] || [];
        list.splice(index, 1);
        await this.persist();
    }

    // Resolve + play audio (Capture) uses this to attach a durable filename
    // to a pending entry in place, the same way the Vocab builder's row tool
    // patches the CSV's audio column for its own word list.
    async patchPendingEntry(vaultCode, index, patch) {
        const list = this.data.pending[vaultCode];
        const e = list && list[index];
        if (e) Object.assign(e, patch);
        await this.persist();
    }

    /* Append pending entries to the language document (and give each a
       vocab note). `indices` limits it to those entries — the Inbox saves
       what is selected; without it, everything pending. */
    async saveToVault(lang, source, indices) {
        const all = this.pendingFor(lang.vault);
        const pick = Array.isArray(indices) ? new Set(indices) : null;
        const entries = pick ? all.filter((_, i) => pick.has(i)) : all;
        const body = entriesToExportBody(lang, entries, source);
        if (!body.entries.length) throw new Error("Nothing to save.");
        const r = await call("vault", this.settings.vaultSidecarUrl, "/lingua/export", body);
        if (this.settings.createVocabNotes) {
            // Notes are built from the raw captured entries, not
            // body.entries — the export payload above only carries the
            // vault sidecar's own Entry contract (term/reading/gloss/
            // rhythm), but a note can also hold audio/traditional/zhuyin/
            // image when the operator attached them (Resolve + play audio,
            // or a hand-edit after capture).
            for (const e of entries) {
                if (String(e.term || "").trim()) {
                    await this.ensureVocabNote(e, lang, body.source);
                }
            }
        }
        this.data.pending[lang.vault] = pick ? all.filter((_, i) => !pick.has(i)) : [];
        await this.persist();
        return (r && r.appended) || body.entries.length;
    }

    async ensureVocabNote(entry, lang, source) {
        const folder = obsidian.normalizePath(this.settings.vocabNoteFolder);
        const path = obsidian.normalizePath(vocabNotePath(folder, lang.vault, entry.term));
        if (this.app.vault.getAbstractFileByPath(path)) return;
        try {
            if (!this.app.vault.getAbstractFileByPath(folder)) {
                await this.app.vault.createFolder(folder).catch(() => {});
            }
            const today = (new Date()).toISOString().slice(0, 10);
            await this.app.vault.create(path, vocabNoteBody(entry, lang, source, today));
        } catch (e) {
            new obsidian.Notice(`Vocab note for ${entry.term} failed: ${e.message || e}`);
        }
    }

    /* ----- builder batches (per card type, persisted) ----- */

    batchFor(type) {
        return this.data.batches[type] || { deck: "", rows: [] };
    }

    async addBatchRow(type, row) {
        const b = this.data.batches[type] = this.data.batches[type]
            || { deck: "", rows: [] };
        b.rows.push(row);
        await this.persist();
    }

    async removeBatchRow(type, index) {
        const b = this.data.batches[type];
        if (!b) return;
        b.rows.splice(index, 1);
        await this.persist();
    }

    async clearBatch(type) {
        if (this.data.batches[type]) this.data.batches[type].rows = [];
        await this.persist();
    }

    async setBatchDeck(type, deck) {
        const b = this.data.batches[type] = this.data.batches[type]
            || { deck: "", rows: [] };
        b.deck = deck.trim();
        await this.persist();
    }

    /* ----- v4 word batches (persisted, per-batch language) -----------------
     * The v4 workbench: each batch holds its own word list, card-type outs,
     * themes, deck, flags, rules and per-card overrides (see the v4 batch
     * logic section for shapes). Batches persist in data.json under `v4`
     * ({batches, cur}); every mutation persists, so nothing typed is ever
     * lost to a restart. Updates go through v4Mut (find by id, replace,
     * persist) so the view layer never touches storage directly.
     */

    v4Store() {
        const v = this.data.v4 = this.data.v4 || { batches: [], cur: null, stacks: [] };
        if (!Array.isArray(v.batches)) v.batches = [];
        if (!Array.isArray(v.stacks)) v.stacks = [];
        return v;
    }

    // A language's batches (base subtag: zh-hans shows zh's batches).
    v4BatchesFor(vault) {
        return this.v4Store().batches.filter((b) => sameLang(b.lang || "zh", vault));
    }

    // The batch the main view shows for a language: the current one when it
    // is that language's, else the language's first.
    v4CurFor(vault) {
        const cur = this.v4Batch(this.v4Store().cur);
        if (cur && sameLang(cur.lang || "zh", vault)) return cur;
        return this.v4BatchesFor(vault)[0] || null;
    }

    v4Batch(id) {
        return this.v4Store().batches.find((b) => b.id === id) || null;
    }

    v4Cur() {
        const v = this.v4Store();
        return this.v4Batch(v.cur) || v.batches[0] || null;
    }

    async v4Add(batch) {
        const v = this.v4Store();
        v.batches.push(batch);
        v.cur = batch.id;
        await this.persist();
        return batch;
    }

    async v4Mut(id, fn) {
        const v = this.v4Store();
        const i = v.batches.findIndex((b) => b.id === id);
        if (i < 0) return null;
        v.batches[i] = Object.assign({}, v.batches[i], fn(v.batches[i]));
        await this.persist();
        return v.batches[i];
    }

    async v4Remove(id) {
        const v = this.v4Store();
        v.batches = v.batches.filter((b) => b.id !== id);
        if (v.cur === id) v.cur = (v.batches[0] && v.batches[0].id) || null;
        await this.persist();
    }

    async v4SetCur(id) {
        this.v4Store().cur = id;
        await this.persist();
    }

    // A copy with fresh word ids (per-card overrides are keyed by word id,
    // so they are re-keyed rather than dropped) and a fresh batch id.
    async v4Duplicate(id) {
        const src = this.v4Batch(id);
        if (!src) return null;
        const idMap = {};
        const words = (src.words || []).map((w) => { const nw = Object.assign({}, w, { id: v4NextId("w") }); idMap[w.id] = nw.id; return nw; });
        const ov = {};
        for (const [k, v] of Object.entries(src.ov || {})) {
            const parts = k.split(":");
            if (idMap[parts[1]]) parts[1] = idMap[parts[1]];
            ov[parts.join(":")] = JSON.parse(JSON.stringify(v));
        }
        const copy = JSON.parse(JSON.stringify(Object.assign({}, src, { words: [], ov: {} })));
        Object.assign(copy, { id: v4NextId("b"), name: src.name + " (copy)", words, ov, lastExport: undefined });
        return this.v4Add(copy);
    }

    async confirmDeleteBatch(id) {
        const b = this.v4Batch(id);
        if (!b) return;
        const ok = await lsConfirm(this.app, "Delete batch",
            `Delete “${b.name}” and its ${(b.words || []).length} words? Cards already in Anki stay there.`, "Delete");
        if (!ok) return;
        await this.v4Remove(id);
        for (const st of this.v4Stacks()) {
            if ((st.steps || []).includes(id)) await this.v4MutStack(st.id, (x) => ({ steps: x.steps.filter((s) => s !== id) }));
        }
        this.rerenderViews();
    }

    /* Stacks: [{id, name, steps: [batchId]}], study order. */
    v4Stacks() { return this.v4Store().stacks; }

    v4Stack(id) { return this.v4Stacks().find((s) => s.id === id) || null; }

    async v4AddStack(name, steps) {
        const st = { id: v4NextId("s"), name: String(name || "New stack"), steps: steps || [] };
        this.v4Stacks().push(st);
        await this.persist();
        this.refreshNav();
        return st;
    }

    async v4MutStack(id, fn) {
        const v = this.v4Store();
        const i = v.stacks.findIndex((s) => s.id === id);
        if (i < 0) return null;
        v.stacks[i] = Object.assign({}, v.stacks[i], fn(v.stacks[i]));
        await this.persist();
        return v.stacks[i];
    }

    async v4RemoveStack(id) {
        const v = this.v4Store();
        v.stacks = v.stacks.filter((s) => s.id !== id);
        await this.persist();
    }

    openNewBatch() {
        new NewBatchModal(this.app, this).open();
    }

    /* ↻ in the sidebar: AnkiConnect's own sync (AnkiWeb), then the backend
       dots are rechecked. */
    async syncAnki(btn) {
        await this.withOp("syncing Anki", async () => {
            const r = await call("anki", this.settings.ankiConnectUrl, "", { action: "sync", version: 6 });
            if (r && r.error) throw new Error("Anki: " + r.error);
            new obsidian.Notice("Synced with Anki.");
        }, btn);
        for (const leaf of this.app.workspace.getLeavesOfType(NAV_VIEW)) {
            if (leaf.view instanceof LinguaNavView) leaf.view.refreshStatus();
        }
    }

    /* ----- misc surface ----- */

    activeLang() { return this.data.activeLang; }

    async setActiveLang(code) {
        this.data.activeLang = code;
        await this.persist();
        for (const leaf of this.app.workspace.getLeavesOfType(MAIN_VIEW)) {
            if (leaf.view instanceof LinguaMainView) leaf.view.setLang(code);
        }
        this.refreshNav();
    }

    copyApkg(tmpPath) {
        const fs = require("fs");
        const path = require("path");
        const os = require("os");
        const dirRaw = this.settings.apkgDir
            || path.join(os.homedir(), "Downloads");
        const dir = dirRaw.replace(/^~(?=$|\/)/, os.homedir());
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, path.basename(tmpPath));
        fs.copyFileSync(tmpPath, dest);
        return dest;
    }

    async openNote(rel) {
        const path = obsidian.normalizePath(rel);
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!f) {
            new obsidian.Notice(`${path} doesn't exist yet — capture something first.`);
            return;
        }
        await this.app.workspace.getLeaf(false).openFile(f);
    }

    runDoctor() {
        new LinguaDoctorModal(this.app, this).open();
    }

    async serviceCall(action) {
        try {
            await obsidian.requestUrl({
                url: String(this.settings.vaultSidecarUrl).replace(/\/$/, "")
                    + `/services/lingua/${action}`,
                method: "POST", throw: false });
        } catch (e) { /* sidecar down — the workbench still degrades cleanly */ }
    }

    requestBackendStart() {
        if (this.settings.autoStartBackend) this.serviceCall("start");
    }

    async openNav() {
        let leaf = this.app.workspace.getLeavesOfType(NAV_VIEW)[0];
        if (!leaf) {
            leaf = this.app.workspace.getLeftLeaf(false);
            await leaf.setViewState({ type: NAV_VIEW, active: true });
        }
        this.app.workspace.revealLeaf(leaf);
    }

    /* Open the main view, optionally somewhere: a screen name (or an old
       section name) or {screen, sub, batch, stack, builderType, tab}.
       Resolves the view. */
    async openMain(route) {
        let leaf = this.app.workspace.getLeavesOfType(MAIN_VIEW)[0];
        // Obsidian 1.7+ defers background views until they are shown.
        if (leaf && typeof leaf.loadIfDeferred === "function") await leaf.loadIfDeferred();
        const r = !route ? null : typeof route === "string" ? v4RouteFor(route) : route;
        if (leaf && leaf.view instanceof LinguaMainView) {
            this.app.workspace.revealLeaf(leaf);
            if (r) await leaf.view.go(r);
            return leaf.view;
        }
        if (!leaf) leaf = this.app.workspace.getLeaf(true);
        const state = { lang: this.data.activeLang };
        if (r) {
            state.screen = r.screen;
            if (r.sub) state.manage = r.sub;
            if (r.batch) state.batch = r.batch;
            if (r.stack) state.stack = r.stack;
            if (r.builderType) state.builderType = r.builderType;
        }
        await leaf.setViewState({ type: MAIN_VIEW, active: true, state });
        this.app.workspace.revealLeaf(leaf);
        const view = leaf.view instanceof LinguaMainView ? leaf.view : null;
        if (view && r && r.tab) { view.ui.tab = r.tab; view.render(); }
        this.refreshNav();
        return view;
    }

    async openWorkspace() {
        const wsp = this.app.internalPlugins && this.app.internalPlugins.plugins
            ? this.app.internalPlugins.plugins.workspaces : null;
        if (wsp && wsp.enabled && wsp.instance && wsp.instance.workspaces
            && wsp.instance.workspaces[WORKSPACE_NAME]
            && typeof wsp.instance.loadWorkspace === "function") {
            wsp.instance.loadWorkspace(WORKSPACE_NAME);
            return;
        }
        await this.openNav();
        await this.openMain();
    }

    ensureWorkspaces(force) {
        const wsp = this.app.internalPlugins && this.app.internalPlugins.plugins
            ? this.app.internalPlugins.plugins.workspaces : null;
        if (!wsp || !wsp.enabled || !wsp.instance) return false;
        const inst = wsp.instance;
        inst.workspaces = inst.workspaces || {};
        if (force || !inst.workspaces[WORKSPACE_NAME]) {
            inst.workspaces[WORKSPACE_NAME] = buildLayout(this.data.activeLang);
            if (typeof inst.saveData === "function") inst.saveData();
        }
        return true;
    }
}

function buildLayout(lang) {
    const mainId = uid();
    return {
        main: {
            id: uid(), type: "split", direction: "vertical",
            children: [{
                id: uid(), type: "tabs",
                children: [{
                    id: mainId, type: "leaf",
                    state: { type: MAIN_VIEW, state: { lang: lang || "zh", screen: "batch" },
                        icon: "languages", title: "Lingua" },
                }],
            }],
        },
        left: {
            id: uid(), type: "split", direction: "horizontal", width: 320,
            children: [{
                id: uid(), type: "tabs",
                children: [{
                    id: uid(), type: "leaf",
                    state: { type: NAV_VIEW, state: {}, icon: "languages", title: "Lingua" },
                }],
            }],
        },
        right: {
            id: uid(), type: "split", direction: "horizontal", width: 300, collapsed: true,
            children: [{ id: uid(), type: "tabs", children: [{ id: uid(), type: "leaf", state: {} }] }],
        },
        active: mainId,
    };
}

/* ------------------------------------------------------------------ */
/* settings tab                                                        */
/* ------------------------------------------------------------------ */

class LinguaSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const el = this.containerEl;
        el.empty();

        const text = (name, desc, key, placeholder) => {
            new obsidian.Setting(el).setName(name).setDesc(desc)
                .addText((t) => t
                    .setPlaceholder(placeholder || DEFAULT_SETTINGS[key])
                    .setValue(this.plugin.settings[key])
                    .onChange(async (v) => {
                        this.plugin.settings[key] = v.trim() || DEFAULT_SETTINGS[key];
                        await this.plugin.saveSettings();
                    }));
        };

        new obsidian.Setting(el)
            .setName("Density")
            .setDesc("The workspace wears your vault's theme; this only tightens the spacing.")
            .addDropdown((d) => {
                d.addOption("comfortable", "Comfortable");
                d.addOption("compact", "Compact");
                d.setValue(this.plugin.settings.density || "comfortable")
                    .onChange(async (v) => {
                        this.plugin.settings.density = v;
                        await this.plugin.saveSettings();
                        this.plugin.rerenderViews();
                    });
            });

        new obsidian.Setting(el).setName("Backends").setHeading();
        text("Vault sidecar URL",
            "Owns storage: append-only language documents, inventory, the "
            + "exported-Anki round-trip, text-to-speech, and the vocab .apkg "
            + "export (see below). Also supervises the engine below.",
            "vaultSidecarUrl");
        text("LinguaStudio engine URL",
            "Owns dictionary lookup, cloze, every card builder, OCR, images, "
            + "genanki, AnkiConnect push. Does NOT own audio/TTS any more — "
            + "that runs in the vault sidecar above regardless of whether "
            + "this engine is even running.",
            "linguaSidecarUrl");
        text("AnkiConnect URL", "Only used by the Lingua doctor's checks.",
            "ankiConnectUrl");
        new obsidian.Setting(el)
            .setName("Start the engine automatically")
            .setDesc("Launch the LinguaStudio engine when this workspace opens "
                + "and let the supervisor stop it a few minutes after the "
                + "workspace closes. Needs lingua_repo set in the Vault "
                + "Sidecar settings. Text-to-speech does not need this — see "
                + "below.")
            .addToggle((t) => t.setValue(this.plugin.settings.autoStartBackend)
                .onChange(async (v) => {
                    this.plugin.settings.autoStartBackend = v;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(el).setName("Text-to-speech").setHeading();
        el.createEl("p", { cls: "setting-item-description",
            text: "Synthesis runs in the vault sidecar itself — edge-tts (online, "
                + "free, many voices), piper (local, offline, no GPU), or gTTS "
                + "(online, simple fallback). None of this needs the LinguaStudio "
                + "engine above; it works whether that's running or not." });
        new obsidian.Setting(el)
            .setName("Default engine")
            .setDesc("Starting engine for the TTS tab. Change it there any time — "
                + "this is only where it starts.")
            .addDropdown((d) => {
                d.addOption("edge", "Edge-TTS (online, free, many voices)");
                d.addOption("piper", "Piper (local, offline, no GPU)");
                d.addOption("gtts", "Google TTS (online, simple fallback)");
                d.setValue(this.plugin.settings.ttsDefaultEngine)
                    .onChange(async (v) => {
                        this.plugin.settings.ttsDefaultEngine = v;
                        this.plugin.settings.ttsDefaultVoice = "";
                        await this.plugin.saveSettings();
                    });
            });

        new obsidian.Setting(el).setName("Capture").setHeading();
        new obsidian.Setting(el)
            .setName("Default language")
            .setDesc("Language used when opening the workspace. Change anytime via the header dropdown.")
            .addText((t) => t
                .setPlaceholder(this.plugin.settings.defaultLang)
                .setValue(this.plugin.settings.defaultLang)
                .onChange(async (v) => {
                    const code = v.trim();
                    if (code && LANGS.find((l) => l.vault === code)) {
                        this.plugin.settings.defaultLang = code;
                        await this.plugin.saveSettings();
                    }
                }));
        new obsidian.Setting(el)
            .setName("Create vocab notes on save")
            .setDesc("One note per captured term — the note carries the "
                + "exported-to-Anki flag, so the inventory's ✓ needs it.")
            .addToggle((t) => t.setValue(this.plugin.settings.createVocabNotes)
                .onChange(async (v) => {
                    this.plugin.settings.createVocabNotes = v;
                    await this.plugin.saveSettings();
                }));
        text("Vocab note folder", "Must live under the sidecar's notes folder.",
            "vocabNoteFolder");
        text("Generated folder", "Where the sidecar writes inventories.",
            "generatedFolder");

        new obsidian.Setting(el).setName("Anki").setHeading();
        text("Deck prefix", "Vocabulary decks are `<prefix>::<Language>`; "
            + "builders carry their own deck defaults.", "deckPrefix");
        text(".apkg export folder", "Empty = ~/Downloads.", "apkgDir", "~/Downloads");

        new obsidian.Setting(el)
            .setName("Recreate the Lingua workspace layout")
            .setDesc("Rewrites the saved \"Lingua\" entry in the core Workspaces "
                + "plugin (it is healed automatically if deleted).")
            .addButton((b) => b.setButtonText("Recreate").onClick(() => {
                const ok = this.plugin.ensureWorkspaces(true);
                new obsidian.Notice(ok ? "Lingua workspace layout recreated."
                    : "Core Workspaces plugin is disabled.");
            }));
    }
}

module.exports = LinguaWorkspacePlugin;
module.exports.__test = {
    ocrPackFor, ocrBaseLang, OCR_PACKS, isMandarinLang,
    LANGS, langByVault, sanitizeFilename, entriesToExportBody, rhythmLines,
    clozeStrip, parseInventoryUnexported, vocabNoteBody, wordsForPush,
    vocabNotePath, mergeNoteFields, serverDownMessage, lookupFailureNotice,
    summarizeVocabRows, SECTIONS, SECTION_LABELS,
    vocabExportSidecar,
    buildLayout, MAIN_VIEW, NAV_VIEW, WORKSPACE_NAME,
    CARD_REGISTRY, specFor, draftFromSpec, batchPayload, linesToRows,
    ttsVoiceId, ttsVoiceLabel, ttsAudioB64, sentenceText, sentenceGloss, packStatus,
    SECTIONS, PACK_KINDS,
    cascadeBeatConfig, cascadeJobs, cascadeMeterCount, vocabTemplateList,
    VOCAB_BASE_TEMPLATES, VOCAB_ALL_TEMPLATES,
    MAX_WHISPER_AUDIO_BYTES, whisperTooLarge, whisperMime, bytesToBase64, whisperText,
    V4_FIELD_KEYS, V4_FLAG_TXT, V4_CONDS, V4_ACTS, V4_WT, V4_WT_TO_FAMILY,
    V4_TPL_TO_FAMILY_TPL, V4_WRITE_CFG_FAMILIES, V4_ND_FLAGS,
    v4Wt, v4NextId, v4MakeWord, v4ToneOf, v4FlagsOf, v4CondHit, v4RuleText,
    v4EffMeaning, v4Cards, v4Skipped, v4ThemeOf, v4RowFor, v4WriteCfg,
    v4BatchToFamilyGroups, V4_FAMILY_FIELDS, v4NewBatch,
    V4_LS_LANGS, v4WordLang, v4AudioTag, v4TypeAvailable,
    V4_THEMES, v4Theme, V4_CATALOG, V4_CATALOG_GROUPS, V4_LANG_GROUPS, V4_LANG_META,
    v4LangNative, sameLang, v4LangGroups, v4ParseGloss, v4MeaningFromSenses,
    v4PinyinMarks, v4SyllableTone, v4Zhuyin, v4LookupPatch, v4CardView, v4Summary,
    V4_EDITABLE, V4_REQUIRED, v4MissingFor, V4_CLASSIC_BUILDER, v4ToneNumbers,
    v4ExportJobs, v4StackSteps, V4_SCREENS, v4RouteFor, v4Ago, v4SplitWords,
};
