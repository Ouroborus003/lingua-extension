/*
Lingua Workspace — LinguaStudio, ported into the vault.

What it is
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
    theme: "sumi",         // LinguaStudio's own token themes
    density: "comfortable", // comfortable | compact (the app's density token)
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

const THEMES = ["sumi", "washi", "konstrukt", "soviet", "terminal"];

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

let _v4Uid = 100;
function v4NextId(prefix) {
    _v4Uid += 1;
    return (prefix || "w") + _v4Uid;
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
    return { id: v4NextId("b"), name: String(name || "New batch"), lang: langVault || "zh",
        source: source || "Typed", words: [],
        outs: [{ type: "vocab", tpls: [0, 1, 2, 3, 4], themes: null, def: null, sub: "Vocab" }],
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
            r = { Simplified: w.S, Traditional: w.T, Pinyin: w.P, Meaning: M, Image: "", Audio: v4AudioTag(w, batch) };
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
   Returns {groups, errors}: `timed` (no v2 family) and unknown out types
   land in errors, never silently dropped. Pure. */
function v4BatchToFamilyGroups(batch) {
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
        const deck = (batch.deck || "LinguaStudio") + (o.sub ? "::" + o.sub : "");
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

class LinguaMainView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.lang = langByVault(plugin.settings.defaultLang);
        this.section = "capture";
        this.builderType = null;
        this.dict = { query: "", results: [], total: 0, offset: 0, busy: false };
        this.cloze = { word: "", context: "", result: null };
        this.ankiSel = new Set();
        this.inventoryTerms = null;
        this.studio = { models: null, sel: null, template: null, draft: {} };
        this.tools = { ocrText: "", ocrTarget: "", images: [], imgQuery: "",
            stackSel: new Set(), whisperText: "" };
        this.tts = { engine: plugin.settings.ttsDefaultEngine || "edge", voices: null,
            voice: plugin.settings.ttsDefaultVoice || "", text: "",
            cacheBytes: null, previewAudio: null };
        this.sent = { word: "", results: [], busy: false };
        this.packs = { dict: null, sentences: null };
        this.vocabDraft = "";
        this.aiProbe = null;   // { running, providerName, models, detail }
        // Cascade builder config (mirrors CascadeComposite state).
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
    getDisplayText() { return `Lingua · ${this.lang.name}`; }

    getState() {
        const st = super.getState();
        st.lang = this.lang.vault;
        st.section = this.section;
        st.builderType = this.builderType;
        return st;
    }

    async setState(state, result) {
        if (state) {
            if (state.lang) this.lang = langByVault(state.lang);
            if (state.section && SECTIONS.includes(state.section)) this.section = state.section;
            if (state.builderType && specFor(state.builderType)) this.builderType = state.builderType;
        }
        await super.setState(state, result);
        this.render();
    }

    async onOpen() {
        this.contentEl.addClass("lingua-view");
        this.plugin.requestBackendStart();
        this.render();
    }

    setLang(code) {
        this.lang = langByVault(code);
        this.ankiSel.clear();
        this.inventoryTerms = null;
        this.render();
        this.leaf.updateHeader && this.leaf.updateHeader();
    }

    setSection(name, builderType) {
        this.section = name;
        if (builderType !== undefined) this.builderType = builderType;
        this.render();
    }

    pending() {
        return this.plugin.pendingFor(this.lang.vault);
    }

    /* ---- language selector (compact dropdown) ---- */
    renderLangSelect(parent) {
        const wrap = parent.createDiv({ cls: "lingua-lang-select-wrap" });
        const btn = wrap.createEl("button", {
            cls: "lingua-lang-btn",
            attr: { "aria-haspopup": "listbox", "aria-expanded": "false" },
        });
        btn.innerHTML = `<span class="lingua-lang-btn-text">${this.lang.name}</span><span class="lingua-lang-btn-chev" aria-hidden="true">▾</span>`;

        const menu = wrap.createEl("div", { cls: "lingua-lang-menu", role: "listbox" });
        for (const l of LANGS) {
            const item = menu.createEl("button", {
                cls: "lingua-lang-menu-item" + (l.vault === this.lang.vault ? " is-active" : ""),
                attr: { role: "option", "data-lang": l.vault, "aria-selected": l.vault === this.lang.vault },
                text: l.name,
            });
            item.addEventListener("click", () => {
                this.setLang(l.vault);
                document.removeEventListener("click", closeMenu);
            });
        }

        let closeMenu = (e) => {
            if (!wrap.contains(e.target)) {
                wrap.classList.remove("open");
                btn.setAttribute("aria-expanded", "false");
                document.removeEventListener("click", closeMenu);
            }
        };
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const isOpen = wrap.classList.toggle("open");
            btn.setAttribute("aria-expanded", isOpen);
            if (isOpen) {
                document.addEventListener("click", closeMenu);
            } else {
                document.removeEventListener("click", closeMenu);
            }
        });
        return wrap;
    }

    /* ----- rendering ----- */

    render() {
        const root = this.contentEl;
        root.empty();
        root.setAttribute("data-lingua-theme", this.plugin.settings.theme);
        root.setAttribute("data-lingua-density", this.plugin.settings.density || "comfortable");

        const header = root.createDiv({ cls: "lingua-header" });
        const title = header.createDiv({ cls: "lingua-header-title" });
        title.createSpan({ cls: "lingua-accent-dot" });
        title.createSpan({ cls: "lingua-header-name", text: "Lingua" });

        /* Language dropdown next to title */
        this.renderLangSelect(title);

        this.busyEl = title.createSpan({ cls: "lingua-busy-chip" });
        this.refreshBusy();

        const tabs = header.createDiv({ cls: "lingua-tabs" });
        for (const s of SECTIONS) {
            const b = tabs.createEl("button", {
                cls: "lingua-tab" + (s === this.section ? " is-active" : ""),
                text: SECTION_LABELS[s],
            });
            b.addEventListener("click", () => this.setSection(s));
        }

        this.bodyEl = root.createDiv({ cls: "lingua-body" });
        if (this.lang.rtl) this.bodyEl.addClass("is-rtl");
        this["render_" + this.section](this.bodyEl);
    }

    refreshBusy() {
        if (!this.busyEl) return;
        const ops = this.plugin.opLabels();
        this.busyEl.setText(ops.length ? `● working — ${ops[ops.length - 1]}` : "");
        this.busyEl.toggleClass("is-on", ops.length > 0);
        this.busyEl.setAttribute("title", ops.join("\n"));
    }

    /* ----- Capture ----- */

    render_capture(el) {
        const form = el.createDiv({ cls: "lingua-form" });
        const term = this.input(form, "Term", "the word or phrase");
        const reading = this.input(form, "Reading", "pinyin / IPA / romanization");
        const gloss = this.input(form, "Meaning", "English gloss");
        const rhythmWrap = form.createDiv({ cls: "lingua-field lingua-field-wide" });
        rhythmWrap.createEl("label", { text: "Rhythm (one unit per line, optional)" });
        const rhythm = rhythmWrap.createEl("textarea", {
            attr: { rows: 2, placeholder: "rhythmic / prosodic units" } });

        const row = form.createDiv({ cls: "lingua-actions" });
        const lookupBtn = row.createEl("button", { text: "Look up" });
        lookupBtn.addEventListener("click", async () => {
            const w = term.value.trim();
            if (!w) return;
            lookupBtn.disabled = true;
            try {
                // Ported off LinguaStudio's :8000 (dead — same port LinguaBrowse's
                // saved-word push was silently failing against). /translate/word
                // is the vault sidecar's own dictionary-first cascade, answering
                // {provider, word, gloss, reading}; mapped onto the {trans,
                // meaning} shape this form already reads, so nothing below here
                // needed to change.
                const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                    "/translate/word", { word: w, src: this.lang.vault, tgt: "EN" });
                const entry = r && r.provider ? { trans: r.reading || "", meaning: r.gloss || "" } : null;
                if (entry) {
                    if (!reading.value) reading.value = entry.trans || "";
                    if (!gloss.value) gloss.value = entry.meaning || "";
                    if (!reading.value && !gloss.value) {
                        new obsidian.Notice("No dictionary entry found.");
                    }
                } else {
                    new obsidian.Notice((r && r.error) || "Lookup failed.");
                }
            } catch (e) {
                new obsidian.Notice(String(e.message || e));
            } finally {
                lookupBtn.disabled = false;
            }
        });

        const addBtn = row.createEl("button", { text: "Add to list", cls: "mod-cta" });
        const add = async () => {
            const w = term.value.trim();
            if (!w) return;
            await this.plugin.addPending(this.lang.vault, {
                term: w, reading: reading.value.trim(),
                gloss: gloss.value.trim(), rhythm: rhythm.value,
            });
            term.value = reading.value = gloss.value = rhythm.value = "";
            term.focus();
            this.render();
        };
        addBtn.addEventListener("click", add);
        term.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); add(); }
        });

        this.renderPendingList(el, { withSave: true });
    }

    renderPendingList(el, opts) {
        const entries = this.pending();
        const box = el.createDiv({ cls: "lingua-pending" });
        const head = box.createDiv({ cls: "lingua-pending-head" });
        head.createEl("h3", { text: `Pending — ${entries.length}` });

        if (!entries.length) {
            box.createDiv({ cls: "lingua-empty",
                text: "Nothing pending. Captured entries collect here until you save them to the vault." });
            return;
        }

        const table = box.createEl("table", { cls: "lingua-table" });
        const thead = table.createEl("thead").createEl("tr");
        for (const h of ["term", "reading", "meaning", ""]) thead.createEl("th", { text: h });
        const tbody = table.createEl("tbody");
        entries.forEach((e, i) => {
            const tr = tbody.createEl("tr");
            tr.createEl("td", { text: e.term, cls: "lingua-term" });
            tr.createEl("td", { text: e.reading || "—" });
            tr.createEl("td", { text: e.gloss || "—" });
            const tools = tr.createEl("td", { cls: "lingua-row-tools" });
            this.rowTool(tools, "volume-2", "Resolve + play audio", async (b) => {
                b.disabled = true;
                try {
                    const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                        "/vocab/audio", { word: e.term, lang: this.lang.lingua });
                    const b64 = ttsAudioB64(r);
                    if (r && r.ok && b64) {
                        this.playWithControls(tools, b64);
                        // The same response the Vocab builder reads a durable
                        // filename from (render_vocab's row tool, which patches
                        // the CSV's audio column) carries one here too — persist
                        // it onto the pending entry so a later Anki push carries
                        // real audio through wordsForPush instead of "".
                        if (r.filename && r.filename !== e.audio) {
                            e.audio = r.filename;
                            await this.plugin.patchPendingEntry(this.lang.vault, i,
                                { audio: r.filename });
                            new obsidian.Notice(`Audio saved for ${e.term}.`);
                        }
                    } else {
                        new obsidian.Notice((r && r.error) || "No audio resolved.");
                    }
                } catch (err) { new obsidian.Notice(String(err.message || err)); }
                finally { b.disabled = false; }
            });
            this.rowTool(tools, "brackets", "Cloze this term", () => {
                this.cloze.word = e.term;
                this.setSection("cloze");
            });
            this.rowTool(tools, "x", "Remove", async () => {
                await this.plugin.removePending(this.lang.vault, i);
                this.render();
            });
        });

        if (opts && opts.withSave) {
            const save = box.createDiv({ cls: "lingua-save" });
            const src = save.createEl("input", {
                attr: { type: "text", placeholder: "source (optional) — e.g. 'Boox — Chapter 3'" } });
            const btn = save.createEl("button", { text: "Save to vault", cls: "mod-cta" });
            btn.addEventListener("click", () => this.plugin.withOp(
                "saving vocabulary", async () => {
                    const n = await this.plugin.saveToVault(this.lang, src.value);
                    new obsidian.Notice(`Appended ${n} entr${n === 1 ? "y" : "ies"} to `
                        + `Vocabulary — ${this.lang.vault}.`);
                    this.inventoryTerms = null;
                    this.render();
                }, btn));
        }
    }

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
                    : "Search results land here. A row's + button adds it to the Capture list." });
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
            this.rowTool(tools, "plus", "Add to the Capture list", async () => {
                await this.plugin.addPending(this.lang.vault, {
                    term: r.word || "", reading: r.trans || "", gloss: r.meaning || "", rhythm: "",
                });
                new obsidian.Notice(`${r.word} → Capture list`);
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
                    + "batches, use Builders → Custom Cloze." });
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
            new obsidian.Notice("→ Builders → Custom Cloze");
        });
        const toList = acts.createEl("button", { text: "Add sentence to Capture list" });
        toList.addEventListener("click", async () => {
            await this.plugin.addPending(this.lang.vault, {
                term: this.cloze.word, reading: "",
                gloss: clozeStrip(r.cloze) + (r.gloss ? ` — ${r.gloss}` : ""), rhythm: "",
            });
            new obsidian.Notice(`${this.cloze.word} → Capture list`);
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
            text: "The real Anki templates behind every card type: fields, "
                + "front/back HTML, and styling. Compose a one-off card against "
                + "any model and push or export it." });

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
        expBtn.addEventListener("click", () => this.exportStack(expBtn));
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

    async exportStack(btn) {
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
        const target = send.createEl("select");
        target.createEl("option", { value: "", text: "— send lines to builder —" });
        for (const group of CARD_REGISTRY.groups) {
            for (const type of group.types) {
                const spec = specFor(type);
                if (spec) target.createEl("option", { value: type, text: spec.title });
            }
        }
        const sendB = send.createEl("button", { text: "Send", cls: "mod-cta" });
        sendB.addEventListener("click", async () => {
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
            text: "Example sentences from the installed corpus (Mandarin ships "
                + "bundled; add more under Manage). Send any sentence into a "
                + "builder, or add it to the Capture list." });

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
            this.rowTool(tools, "list-plus", "Send to a builder", () => {
                this.tools.ocrText = text;
                new obsidian.Notice("In the Tools → send-lines box (or use Capture).");
            });
            this.rowTool(tools, "notebook-pen", "Add to Capture list", async () => {
                await this.plugin.addPending(this.lang.vault,
                    { term: this.sent.word, reading: "", gloss: text, rhythm: "" });
                new obsidian.Notice("→ Capture list");
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

    render_review(el) {
        el.createDiv({ cls: "lingua-lede",
            text: "Reviewing happens in Reading Companion — one scheduler, so "
                + "an interval never diverges between two surfaces. This opens "
                + "its Study view directly, on whatever is due for every card "
                + "kind: derived vocab cards, and the mnemonic/writing/cascade "
                + "cards authored here (via Builders and Card Studio)." });
        const rc = this.readingCompanion();
        const box = el.createDiv({ cls: "lingua-pending" });
        if (!rc) {
            box.createDiv({ cls: "lingua-empty",
                text: "Reading Companion is not installed or enabled — nothing to open." });
            return;
        }
        const studyBtn = box.createEl("button", { text: "Study due cards", cls: "mod-cta" });
        studyBtn.addEventListener("click", () => rc.openStudy());
    }

    render_stats(el) {
        el.createDiv({ cls: "lingua-lede",
            text: "A quick-glance count from the vocabulary CSV — the full, "
                + "sortable views (unknown-by-frequency, receptive-but-not-"
                + "productive, the mining queue) live in the DataviewJS "
                + "'Vocabulary — <lang>' note; this reads the same record "
                + "rather than a second copy of it." });
        const box = el.createDiv({ cls: "lingua-pending" });
        box.createDiv({ cls: "lingua-hint", text: "Loading…" });
        this.plugin.withOp("loading stats", async () => {
            const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                `/vocab/rows?lang=${encodeURIComponent(this.lang.vault)}&enrich=0`);
            box.empty();
            const rows = (r && r.rows) || [];
            if (!rows.length) {
                box.createDiv({ cls: "lingua-empty", text: "No words tracked yet for "
                    + this.lang.name + "." });
                return;
            }
            const s = summarizeVocabRows(rows);
            const table = box.createEl("table", { cls: "lingua-table" });
            const thead = table.createEl("thead").createEl("tr");
            for (const h of ["Total", "Known", "Learning", "Seen", "Unknown", "Productive", "Ignored"]) {
                thead.createEl("th", { text: h });
            }
            const tr = table.createEl("tbody").createEl("tr");
            for (const v of [s.total, s.known, s.learning, s.seen, s.unknown, s.productive, s.ignored]) {
                tr.createEl("td", { text: String(v) });
            }
        });
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

    /* ----- Vocab (flagship multi-template card builder) ----- */

    // Every word's reading/gloss/audio/image now lives in the sidecar's
    // shared vocabulary CSV (spec §10 rewrite), not in this plugin's
    // data.json. render_vocab (sync, per the "render_" + section dispatcher)
    // cannot await a fetch inline, so it reads an instance-level cache and
    // kicks off a background refresh that calls this.render() again when the
    // rows land — the same "mutate then re-render" idiom used everywhere else
    // in this file, just fronted by a cache so a fast re-render (adding a
    // second word right after the first) does not fire a second fetch.
    _vocabRowsFor(vaultCode) {
        const cache = this._vocabRowsCache;
        const fresh = cache && cache.vault === vaultCode && (Date.now() - cache.t) < 15000;
        if (!fresh) {
            this._vocabFetchInFlight = this._vocabFetchInFlight || {};
            if (!this._vocabFetchInFlight[vaultCode]) {
                this._vocabFetchInFlight[vaultCode] = true;
                call("vault", this.plugin.settings.vaultSidecarUrl,
                    `/vocab/rows?lang=${encodeURIComponent(vaultCode)}&enrich=1`)
                    .then((r) => {
                        this._vocabRowsCache = { vault: vaultCode, rows: (r && r.rows) || [], t: Date.now() };
                    })
                    .catch(() => {
                        this._vocabRowsCache = { vault: vaultCode, rows: [], t: Date.now() };
                    })
                    .finally(() => { delete this._vocabFetchInFlight[vaultCode]; this.render(); });
            }
        }
        return (cache && cache.vault === vaultCode) ? cache.rows : [];
    }

    render_vocab(el) {
        el.createDiv({ cls: "lingua-lede",
            text: "The flagship vocabulary builder: one word list, several Anki "
                + "card templates at once. Each word is enriched from the "
                + "dictionary and gets audio resolved automatically; add Visual "
                + "to attach images. Export or push builds every selected "
                + "template per word." });

        const vaultCode = this.lang.vault;
        const terms = this.plugin.vocabTermsFor(vaultCode);
        const sel = this.plugin.vocabSelected(vaultCode);
        const rowsByTerm = new Map(this._vocabRowsFor(vaultCode).map((r) => [r.term, r]));
        // A term just added, or added while offline, may not be in the cache
        // yet — show it bare rather than dropping it from the list. The next
        // background refresh fills it in.
        const words = terms.map((term) => rowsByTerm.get(term)
            || { term, reading: "", gloss: "", audio: "", image: "" });

        const legacy = this.plugin._vocab(vaultCode)._legacyWords;
        if (legacy && legacy.length) {
            const warn = el.createDiv({ cls: "lingua-hint lingua-migrate-hint" });
            warn.createSpan({ text: `${legacy.length} word(s) from before this workspace `
                + "moved to the shared vocabulary record are not migrated yet. " });
            const mig = warn.createEl("button", { text: "Migrate now" });
            mig.addEventListener("click", () => this.plugin.withOp("migrating vocabulary",
                async () => {
                    const r = await this.plugin.migrateVocabToCsv(vaultCode);
                    this._vocabRowsCache = null;
                    new obsidian.Notice(r.failed
                        ? `Migrated ${r.migrated}, ${r.failed} failed — sidecar reachable?`
                        : `Migrated ${r.migrated} word(s).`);
                    this.render();
                }, mig));
        }

        // template picker
        const tpl = el.createDiv({ cls: "lingua-pending" });
        tpl.createEl("h3", { text: "Card templates" });
        const chips = tpl.createDiv({ cls: "lingua-chip-row" });
        for (const t of VOCAB_ALL_TEMPLATES) {
            const on = sel.includes(t);
            const chip = chips.createEl("button", {
                cls: "lingua-chip" + (on ? " is-active" : ""), text: t });
            chip.addEventListener("click", async () => {
                const next = on ? sel.filter((x) => x !== t) : [...sel, t];
                await this.plugin.setVocabSelected(this.lang.vault,
                    VOCAB_ALL_TEMPLATES.filter((x) => next.includes(x)));
                this.render();
            });
        }
        const eff = vocabTemplateList(sel);
        tpl.createDiv({ cls: "lingua-hint", text: eff.length
            ? `Sends ${eff.length} template(s): ${eff.join(", ")}.`
            : "Classic default — the stock 5-template model." });

        // add words
        const form = el.createDiv({ cls: "lingua-form" });
        const wWrap = form.createDiv({ cls: "lingua-field lingua-field-wide" });
        wWrap.createEl("label", { text: "Words (one per line, or space-separated)" });
        const ta = wWrap.createEl("textarea", { attr: { rows: 2,
            placeholder: "苹果\n香蕉  葡萄" } });
        ta.value = this.vocabDraft;
        ta.addEventListener("input", () => { this.vocabDraft = ta.value; });
        const addB = form.createEl("button", { text: "Add + look up", cls: "mod-cta" });
        addB.addEventListener("click", () => this.plugin.withOp("adding vocabulary",
            async () => {
                const raw = this.vocabDraft.split(/[\n\s]+/).map((w) => w.trim())
                    .filter(Boolean);
                if (!raw.length) return;
                for (const w of raw) {
                    if (terms.includes(w)) continue;
                    // Upserts the term into the shared CSV (creating it if this is
                    // the first time it has ever been captured) and adds it to this
                    // batch. Reading/gloss are NOT looked up here — the next
                    // background refresh (_vocabRowsFor) pulls them from the
                    // dictionary-join route, so this no longer depends on
                    // LinguaStudio's separate :8000 sidecar at all.
                    await this.plugin.addVocabTerm(vaultCode, w);
                }
                this.vocabDraft = "";
                this._vocabRowsCache = null;
                this.render();
            }, addB));

        // word table
        const box = el.createDiv({ cls: "lingua-pending" });
        box.createEl("h3", { text: `Words — ${words.length}` });
        if (!words.length) {
            box.createDiv({ cls: "lingua-empty", text: "No words yet." });
        } else {
            const table = box.createEl("table", { cls: "lingua-table" });
            const thead = table.createEl("thead").createEl("tr");
            // "trad" (traditional) and zhuyin are dropped: they were dictionary
            // content the old per-word lookup supplied, and 3.4's enrich route
            // only joins reading/gloss. Re-add if/when the dictionary join grows
            // those fields — this is a real, visible reduction, not an oversight.
            const cols = ["word", "reading", "gloss", "audio"];
            if (sel.includes("Visual")) cols.push("image");
            cols.push("");
            for (const h of cols) thead.createEl("th", { text: h });
            const tbody = table.createEl("tbody");
            words.forEach((w) => {
                const tr = tbody.createEl("tr");
                tr.createEl("td", { text: w.term, cls: "lingua-term" });
                tr.createEl("td", { text: w.reading || "—" });
                tr.createEl("td", { text: w.gloss || "—" });
                const audioCell = tr.createEl("td", { text: w.audio ? "✓" : "—",
                    cls: w.audio ? "" : "lingua-hint" });
                if (sel.includes("Visual")) {
                    tr.createEl("td", { text: w.image ? "✓" : "—",
                        cls: w.image ? "" : "lingua-hint" });
                }
                const tools = tr.createEl("td", { cls: "lingua-row-tools" });
                this.rowTool(tools, "volume-2", "Resolve + play audio", async (b) => {
                    b.disabled = true;
                    try {
                        const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                            "/vocab/audio", { word: w.term, lang: this.lang.lingua });
                        if (r && r.ok) {
                            const filename = r.filename || w.audio;
                            await call("vault", this.plugin.settings.vaultSidecarUrl,
                                "/vocab/patch", { lang: vaultCode, term: w.term,
                                    fields: { audio: filename } });
                            w.audio = filename;   // keep the cached row in step
                            if (this._vocabRowsCache) {
                                const cached = this._vocabRowsCache.rows.find((x) => x.term === w.term);
                                if (cached) cached.audio = filename;
                            }
                            // Update the ✓ cell in place rather than this.render() —
                            // a full re-render would tear down the player below the
                            // instant it appeared, which is exactly the "no way to
                            // pause it" gap this replaces new Audio().play() to fix.
                            audioCell.setText("✓");
                            audioCell.removeClass("lingua-hint");
                            const b64 = ttsAudioB64(r);
                            if (b64) this.playWithControls(tools, b64);
                        } else {
                            new obsidian.Notice((r && r.error) || "No audio.");
                        }
                    } catch (e) { new obsidian.Notice(String(e.message || e)); }
                    finally { b.disabled = false; }
                });
                this.rowTool(tools, "link", "Relate to another saved term", () => {
                    // Seed with the rows render_vocab already fetched so the
                    // autocomplete is instant; load() refreshes after writes.
                    new RelateModal(this.app, this, w.term,
                        this._vocabRowsFor(vaultCode)).open();
                });
                if (sel.includes("Visual")) {
                    this.rowTool(tools, "image", "Find an image", () => {
                        this.tools.imgQuery = w.term;
                        this.setSection("tools");
                        new obsidian.Notice("Search in Tools → Images, then paste the "
                            + "filename here via the pencil.");
                    });
                }
                // "Remove" takes the term out of THIS BATCH only — the shared CSV
                // row (and whatever coverage/ledger history it carries) is never
                // touched. Deleting tracked vocabulary is not a feature this view
                // has, deliberately.
                this.rowTool(tools, "x", "Remove from this batch", async () => {
                    await this.plugin.removeVocabTerm(vaultCode, w.term);
                    this.render();
                });
            });
        }

        const acts = el.createDiv({ cls: "lingua-actions lingua-anki-actions" });
        const form2 = el.createDiv({ cls: "lingua-form" });
        const dWrap = form2.createDiv({ cls: "lingua-field" });
        dWrap.createEl("label", { text: "Deck" });
        const deck = dWrap.createEl("input", { attr: { type: "text" } });
        deck.value = `${this.plugin.settings.deckPrefix}::${this.lang.name}`;
        // Field NAMES here are the /vocab/push + /vocab/export contract and are
        // unchanged from before this rewrite — only the SOURCE of each value
        // moved, from a plugin-local word object to the CSV+enrich row.
        // traditional/zhuyin have no source now (enrich only joins
        // reading/gloss) and go out blank, same as the "trad" column above.
        const payload = (extra) => ({
            words: words.map((w) => ({ word: w.term, trans: w.reading || "",
                meaning: w.gloss || "", audio: w.audio || "",
                traditional: "", zhuyin: "",
                image: w.image || "" })),
            lang: this.lang.lingua, deckName: deck.value.trim(),
            selectedTemplates: vocabTemplateList(sel), ...extra });
        const pushB = acts.createEl("button", { text: "Push to Anki", cls: "mod-cta" });
        pushB.addEventListener("click", () => this.plugin.withOp("pushing vocabulary cards",
            async () => {
                if (!words.length) throw new Error("No words.");
                const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                    "/vocab/push", payload({}));
                if (!r || r.ok === false) throw new Error((r && r.error) || "Push failed.");
                new obsidian.Notice(`Pushed ${words.length} word(s) × `
                    + `${eff.length || 5} template(s).`);
            }, pushB));
        const expB = acts.createEl("button", { text: "Export .apkg" });
        expB.addEventListener("click", () => this.plugin.withOp("exporting vocabulary cards",
            async () => {
                if (!words.length) throw new Error("No words.");
                const target = vocabExportSidecar(this.plugin.settings);
                const r = await call(target.kind, target.base,
                    "/vocab/export", payload({ filename: "" }));
                if (!r || r.ok === false || !r.path) {
                    throw new Error((r && r.error) || "Export failed.");
                }
                new obsidian.Notice(`Exported → ${this.plugin.copyApkg(r.path)}`, 8000);
            }, expB));
        const clr = acts.createEl("button", { text: "Clear" });
        clr.title = "Empty this batch (the shared vocabulary CSV is not affected)";
        clr.addEventListener("click", async () => {
            await this.plugin.clearVocab(vaultCode);
            this.render();
        });
        // deck field sits above the actions visually
        el.insertBefore(form2, acts);
    }

    /* ----- Settings ----- */

    render_settings(el) {
        const s = this.plugin.settings;
        el.createDiv({ cls: "lingua-lede",
            text: "Everything the workspace and its engines use, in one place. "
                + "Changes save immediately." });

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

        // Appearance
        const app = group("Appearance");
        selectRow(app, "Theme", "theme", THEMES, () => this.plugin.rerenderViews());
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

    /* ----- Anki (vocab round-trip) ----- */

    async loadInventory() {
        const path = `${this.plugin.settings.generatedFolder}/Language Inventory — ${this.lang.vault}.md`;
        const f = this.app.vault.getAbstractFileByPath(obsidian.normalizePath(path));
        if (!f) { this.inventoryTerms = []; return; }
        const text = await this.app.vault.cachedRead(f);
        this.inventoryTerms = parseInventoryUnexported(text);
    }

    render_anki(el) {
        const entries = this.pending();
        const info = el.createDiv({ cls: "lingua-lede" });
        info.setText("Push sends these cards to Anki through LinguaStudio's "
            + "engine; export builds the .apkg in the vault sidecar instead. "
            + "Either way, inventory picks not yet captured are still "
            + "resolved through LinguaStudio's lookup first. After a "
            + "successful push the terms are marked exported in the vault "
            + "and the inventory shows ✓. Card-type batches push from their "
            + "own builders.");

        const form = el.createDiv({ cls: "lingua-form" });
        const deck = this.input(form, "Deck",
            `${this.plugin.settings.deckPrefix}::${this.lang.name}`);
        deck.value = `${this.plugin.settings.deckPrefix}::${this.lang.name}`;

        const box = el.createDiv({ cls: "lingua-anki-pick" });
        box.createEl("h3", { text: `Pending entries — ${entries.length}` });
        if (!entries.length) {
            box.createDiv({ cls: "lingua-empty", text: "Capture some entries first, or pull un-exported terms from the inventory below." });
        }
        const list = box.createEl("div", { cls: "lingua-check-list" });
        entries.forEach((e) => {
            const key = "p:" + e.term;
            const label = list.createEl("label", { cls: "lingua-check" });
            const cb = label.createEl("input", { attr: { type: "checkbox" } });
            cb.checked = this.ankiSel.has(key) || this.ankiSel.size === 0;
            cb.addEventListener("change", () => {
                if (cb.checked) this.ankiSel.add(key); else this.ankiSel.delete(key);
            });
            label.createSpan({ text: ` ${e.term}` + (e.gloss ? ` — ${e.gloss}` : "") });
        });

        const invBox = el.createDiv({ cls: "lingua-anki-pick" });
        const invHead = invBox.createDiv({ cls: "lingua-pending-head" });
        invHead.createEl("h3", { text: "Inventory — not yet in Anki" });
        const loadBtn = invHead.createEl("button", { text: this.inventoryTerms ? "Reload" : "Load" });
        loadBtn.addEventListener("click", async () => {
            await this.loadInventory();
            this.render();
        });
        if (this.inventoryTerms === null) {
            invBox.createDiv({ cls: "lingua-empty",
                text: "Load parses the generated inventory note for terms without ✓." });
        } else if (!this.inventoryTerms.length) {
            invBox.createDiv({ cls: "lingua-empty", text: "Everything in the inventory is already exported. ✓" });
        } else {
            const ilist = invBox.createEl("div", { cls: "lingua-check-list" });
            for (const t of this.inventoryTerms) {
                const key = "i:" + t;
                const label = ilist.createEl("label", { cls: "lingua-check" });
                const cb = label.createEl("input", { attr: { type: "checkbox" } });
                cb.checked = this.ankiSel.has(key);
                cb.addEventListener("change", () => {
                    if (cb.checked) this.ankiSel.add(key); else this.ankiSel.delete(key);
                });
                label.createSpan({ text: " " + t });
            }
        }

        const acts = el.createDiv({ cls: "lingua-actions lingua-anki-actions" });
        const pushBtn = acts.createEl("button", { text: "Push to Anki", cls: "mod-cta" });
        pushBtn.addEventListener("click", () => this.runAnki("push", deck.value, pushBtn));
        const exportBtn = acts.createEl("button", { text: "Export .apkg" });
        exportBtn.addEventListener("click", () => this.runAnki("export", deck.value, exportBtn));
    }

    async runAnki(mode, deckName, btn) {
        const entries = this.pending();
        const chosen = [];
        const seen = new Set();
        const wantAllPending = this.ankiSel.size === 0;
        for (const e of entries) {
            if ((wantAllPending || this.ankiSel.has("p:" + e.term)) && !seen.has(e.term)) {
                chosen.push(e);
                seen.add(e.term);
            }
        }
        const lookups = [...this.ankiSel].filter((k) => k.startsWith("i:"))
            .map((k) => k.slice(2)).filter((t) => !seen.has(t));

        if (!chosen.length && !lookups.length) {
            new obsidian.Notice("Nothing selected.");
            return;
        }
        await this.plugin.withOp(
            mode === "push" ? "pushing vocabulary" : "exporting vocabulary",
            async () => {
                let lookupFailures = 0;
                for (const term of lookups) {
                    try {
                        // Ported off LinguaStudio's dead :8000 — see the "Look up"
                        // button handler above for the same mapping.
                        const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                            "/translate/word", { word: term, src: this.lang.vault, tgt: "EN" });
                        chosen.push(r && r.provider
                            ? { term, reading: r.reading || "", gloss: r.gloss || "" }
                            : { term, reading: "", gloss: "" });
                    } catch (e) {
                        // Swallowed on purpose — one flaky lookup shouldn't
                        // abort the whole push — but not silently: counted
                        // and reported once below, so "Pushed N note(s)"
                        // doesn't read as a clean run when some were blank.
                        chosen.push({ term, reading: "", gloss: "" });
                        lookupFailures++;
                    }
                }
                const failNotice = lookupFailureNotice(lookupFailures, lookups.length);
                if (failNotice) new obsidian.Notice(failNotice, 8000);

                this.enrichFromNotes(chosen);
                const words = wordsForPush(chosen);
                const payload = { words, lang: this.lang.lingua,
                    deckName: deckName.trim(), selectedTemplates: [] };

                if (mode === "push") {
                    const r = await call("lingua", this.plugin.settings.linguaSidecarUrl,
                        "/vocab/push", payload);
                    if (!r || r.ok === false) {
                        throw new Error((r && r.error) || "Push failed — is Anki open?");
                    }
                    new obsidian.Notice(`Pushed ${words.length} note(s) to ${deckName}.`);
                } else {
                    // /vocab/export builds the .apkg itself, against the vault
                    // sidecar (app/routers/anki.py, mirroring LinguaStudio's own
                    // /vocab/export contract byte-for-byte so the payload/response
                    // shape needed no change when this ported).
                    const target = vocabExportSidecar(this.plugin.settings);
                    const r = await call(target.kind, target.base,
                        "/vocab/export", { ...payload, filename: "" });
                    if (!r || r.ok === false || !r.path) {
                        throw new Error((r && r.error) || "Export failed.");
                    }
                    const dest = this.plugin.copyApkg(r.path);
                    new obsidian.Notice(`Exported ${words.length} note(s) → ${dest}`, 8000);
                }

                try {
                    await call("vault", this.plugin.settings.vaultSidecarUrl,
                        "/lingua/anki-exported",
                        { language: this.lang.vault, terms: words.map((w) => w.word) });
                } catch (e) {
                    new obsidian.Notice("Cards done, but the vault sidecar is down — "
                        + "inventory ✓ will catch up when it's back.", 8000);
                }
                this.ankiSel.clear();
                this.inventoryTerms = null;
                this.render();
            }, btn);
    }

    // wordsForPush hardcodes nothing itself — it just maps whatever an entry
    // carries. This is where the richer values actually come from: a
    // captured entry's own in-memory state (audio, if Resolve + play audio
    // ran this session) topped up from its vocab note's frontmatter
    // (traditional/zhuyin/image, or audio if hand-added after capture). No
    // note — createVocabNotes off, term never saved, or the field genuinely
    // absent — just leaves wordsForPush's own "" default standing.
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
/* the nav view                                                        */
/* ------------------------------------------------------------------ */

class LinguaNavView extends obsidian.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.status = { vault: null, lingua: null };
    }

    getViewType() { return NAV_VIEW; }
    getIcon() { return "languages"; }
    getDisplayText() { return "Lingua"; }

    async onOpen() {
        this.contentEl.addClass("lingua-nav");
        this.plugin.requestBackendStart();
        this.render();
        this.refreshStatus();
    }

    async refreshStatus() {
        const probe = async (kind, base) => {
            try {
                const r = await call(kind, base, "/health");
                return !!r;
            } catch (e) { return false; }
        };
        const s = this.plugin.settings;
        [this.status.vault, this.status.lingua] = await Promise.all([
            probe("vault", s.vaultSidecarUrl), probe("lingua", s.linguaSidecarUrl)]);
        this.render();
    }

    render() {
        const root = this.contentEl;
        root.empty();
        root.setAttribute("data-lingua-theme", this.plugin.settings.theme);
        root.setAttribute("data-lingua-density", this.plugin.settings.density || "comfortable");

        const langBox = root.createDiv({ cls: "lingua-nav-langs" });
        const active = this.plugin.activeLang();
        for (const l of LANGS) {
            const b = langBox.createEl("button", {
                cls: "lingua-nav-lang" + (active === l.vault ? " is-active" : ""),
                text: l.name,
            });
            b.addEventListener("click", async () => {
                await this.plugin.setActiveLang(l.vault);
                this.render();
            });
        }

        const links = root.createDiv({ cls: "lingua-nav-links" });
        const link = (icon, text, fn) => {
            const a = links.createDiv({ cls: "lingua-nav-link" });
            const ic = a.createSpan({ cls: "lingua-nav-icon" });
            obsidian.setIcon(ic, icon);
            a.createSpan({ text });
            a.addEventListener("click", fn);
        };
        const lang = langByVault(active);
        link("notebook-pen", "Capture", () => this.plugin.openMain("capture"));
        link("book-marked", "Vocab", () => this.plugin.openMain("vocab"));
        link("book-a", "Dictionary", () => this.plugin.openMain("dictionary"));
        link("quote", "Sentences", () => this.plugin.openMain("sentences"));
        link("layers", "Builders", () => this.plugin.openMain("builders"));
        link("panel-top", "Card Studio", () => this.plugin.openMain("studio"));
        link("volume-2", "TTS", () => this.plugin.openMain("tts"));
        link("wrench", "Tools", () => this.plugin.openMain("tools"));
        link("hard-drive-download", "Manage", () => this.plugin.openMain("manage"));
        link("settings", "Settings", () => this.plugin.openMain("settings"));
        link("star", "Anki", () => this.plugin.openMain("anki"));
        links.createDiv({ cls: "lingua-nav-sep" });
        link("scroll-text", `Vocabulary — ${lang.vault}`, () =>
            this.plugin.openNote(`01 Notes/linguistics/Vocabulary — ${lang.vault}.md`));
        link("list-ordered", "Inventory", () =>
            this.plugin.openNote(`${this.plugin.settings.generatedFolder}/Language Inventory — ${lang.vault}.md`));
        link("stethoscope", "Lingua doctor", () => this.plugin.runDoctor());

        const stat = root.createDiv({ cls: "lingua-nav-status" });
        const dot = (label, state, hint) => {
            const row = stat.createDiv({ cls: "lingua-status-row", attr: { title: hint } });
            row.createSpan({ cls: "lingua-status-dot "
                + (state === null ? "is-unknown" : state ? "is-up" : "is-down") });
            row.createSpan({ text: label });
        };
        dot("vault sidecar", this.status.vault, this.plugin.settings.vaultSidecarUrl);
        dot("LinguaStudio engine", this.status.lingua, this.plugin.settings.linguaSidecarUrl);
        const re = stat.createEl("button", { cls: "lingua-status-refresh", text: "recheck" });
        re.addEventListener("click", () => this.refreshStatus());
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
        this.contentEl.setAttribute("data-lingua-theme", this.plugin.settings.theme);
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
    constructor(app, view, word, initialRows) {
        super(app);
        this.view = view;
        this.plugin = view.plugin;
        this.word = word;
        this.rows = initialRows || [];
        this.family = "synonyms";
    }

    onOpen() {
        this.titleEl.setText(`Relate ${this.word}`);
        this.contentEl.addClass("lingua-relate");
        this.contentEl.setAttribute("data-lingua-theme", this.plugin.settings.theme);
        this.load();
    }

    async load() {
        try {
            // Fresh rows: the seed from render_vocab may be up to 15s old, and
            // this modal's own writes make the CSV the source of truth.
            const r = await call("vault", this.plugin.settings.vaultSidecarUrl,
                `/vocab/rows?lang=${encodeURIComponent(this.view.lang.vault)}&enrich=1`);
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
                `${this.word} is not on record yet — save it first.` });
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
                { lang: this.view.lang.vault, a: this.word, b: target,
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
                            "/vocab/relate", { lang: this.view.lang.vault, a: this.word,
                                b: t, family: f.value, add: false });
                        await this.load();
                    }, chip));
            }
        }
    }

    onClose() {
        // Stale the vocab cache so the table re-reads the CSV with the new
        // relations; the modal's own loads already kept the list current.
        this.view._vocabRowsCache = null;
        this.view.render();
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
            v4: data.v4 || { batches: [], cur: null },  // v4 word batches — see v4Store()
        };
        this.ops = new Map();
        this.hadViews = false;

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
        this.addCommand({ id: "lingua-doctor", name: "Lingua doctor",
            callback: () => this.runDoctor() });
        this.addSettingTab(new LinguaSettingTab(this.app, this));

        this.app.workspace.onLayoutReady(() => {
            this.hadViews = this.viewCount() > 0;
            this.ensureWorkspaces(false);
        });
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

    async saveToVault(lang, source) {
        const entries = this.pendingFor(lang.vault);
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
        this.data.pending[lang.vault] = [];
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
        const v = this.data.v4 = this.data.v4 || { batches: [], cur: null };
        if (!Array.isArray(v.batches)) v.batches = [];
        return v;
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

    /* ----- misc surface ----- */

    activeLang() { return this.data.activeLang; }

    async setActiveLang(code) {
        this.data.activeLang = code;
        await this.persist();
        for (const leaf of this.app.workspace.getLeavesOfType(MAIN_VIEW)) {
            if (leaf.view instanceof LinguaMainView) leaf.view.setLang(code);
        }
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

    async openMain(section) {
        let leaf = this.app.workspace.getLeavesOfType(MAIN_VIEW)[0];
        if (!leaf) leaf = this.app.workspace.getLeaf(true);
        const state = { lang: this.data.activeLang };
        if (section) state.section = section;
        await leaf.setViewState({ type: MAIN_VIEW, active: true, state });
        this.app.workspace.revealLeaf(leaf);
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
                    state: { type: MAIN_VIEW, state: { lang: lang || "zh", section: "capture" },
                        icon: "languages", title: "Lingua" },
                }],
            }],
        },
        left: {
            id: uid(), type: "split", direction: "horizontal", width: 260,
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
            .setName("Theme")
            .setDesc("LinguaStudio's own look, applied to the whole workspace. "
                + "Sumi is the app's default.")
            .addDropdown((d) => {
                for (const t of THEMES) d.addOption(t, t);
                d.setValue(this.plugin.settings.theme)
                    .onChange(async (v) => {
                        this.plugin.settings.theme = v;
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
    CARD_REGISTRY, specFor, draftFromSpec, batchPayload, linesToRows, THEMES,
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
    V4_LS_LANGS, v4WordLang, v4AudioTag,
};
