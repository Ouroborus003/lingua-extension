/* Headless tests for lingua-workspace. No Obsidian, no network: an obsidian
   shim lets the pure helpers (language mapping, export payloads, inventory
   parsing, vocab-note bodies, cloze stripping, layout) run under plain node.

       node .obsidian/plugins/lingua-workspace/test/run.js

   The live paths (both sidecars, AnkiConnect) are the Lingua doctor's job —
   these cover only what is deterministic offline. */

"use strict";

const assert = require("assert");
const path = require("path");
const Module = require("module");

/* ----- obsidian shim ----- */
class Base {}
const shim = new Proxy({
    Plugin: Base, ItemView: Base, Modal: Base, PluginSettingTab: Base,
    Setting: Base, Notice: class { constructor() {} },
    setIcon() {}, normalizePath: (s) => s,
    requestUrl() { return Promise.resolve({ status: 200, json: {} }); },
}, { get(t, p) { return p in t ? t[p] : Base; } });

const origLoad = Module._load;
Module._load = function (req, ...rest) {
    if (req === "obsidian") return shim;
    return origLoad.call(this, req, ...rest);
};

const T = require(path.join(__dirname, "..", "main.js")).__test;

let passed = 0;
function ok(name, cond) {
    assert.ok(cond, name);
    passed++;
    console.log("  ok  " + name);
}

/* ================= language registry ================= */
console.log("language registry");
/* The five the operator actually studies must each be PRESENT and map to the
   right LinguaStudio code. Deliberately not `LANGS.length === 5`: the registry
   is additive — zh-hans/zh-hant/yue and the rest of the offerable set were
   added on top — so a row count asserted the size of a list that was always
   going to grow, and broke on a change that took nothing away. Counting rows
   also could not have caught the failure that matters here, which is one of
   these five going missing or being remapped; every entry could be replaced
   and the count would still read five. */
for (const [vault, lingua] of [["zh", "cmn"], ["de", "deu"], ["ar", "ara"], ["hu", "hun"], ["es", "spa"]]) {
    const row = T.LANGS.find((l) => l.vault === vault);
    ok(`${vault} is in the registry`, !!row);
    ok(`${vault} maps to ${lingua}`, row && row.lingua === lingua);
}
ok("zh maps to cmn", T.langByVault("zh").lingua === "cmn");
ok("de maps to deu", T.langByVault("de").lingua === "deu");
ok("ar maps to ara and is RTL", T.langByVault("ar").lingua === "ara" && T.langByVault("ar").rtl);
ok("hu maps to hun", T.langByVault("hu").lingua === "hun");
ok("es maps to spa", T.langByVault("es").lingua === "spa");
ok("unknown code falls back to first", T.langByVault("xx").vault === "zh");

/* ================= sanitizeFilename ================= */
console.log("sanitizeFilename");
ok("CJK survives", T.sanitizeFilename("汉字") === "汉字");
ok("forbidden chars replaced", !/[\\/:*?"<>|#^[\]]/.test(T.sanitizeFilename('a/b:c*d?"e<f>g|h#i[j]')));
ok("empty -> untitled", T.sanitizeFilename("  ") === "untitled");

/* ================= entriesToExportBody ================= */
console.log("entriesToExportBody");
const body = T.entriesToExportBody(T.langByVault("zh"), [
    { term: " 网球 ", reading: "wǎngqiú", gloss: "tennis", rhythm: "wǎng\nqiú\n\n" },
    { term: "", reading: "dropped", gloss: "", rhythm: "" },
], "  Boox — Ch. 3 ");
ok("language is the vault code", body.language === "zh");
ok("source trimmed", body.source === "Boox — Ch. 3");
ok("empty terms dropped", body.entries.length === 1);
ok("term trimmed", body.entries[0].term === "网球");
ok("rhythm split into clean units",
    JSON.stringify(body.entries[0].rhythm) === JSON.stringify(["wǎng", "qiú"]));
ok("array rhythm passes through",
    JSON.stringify(T.rhythmLines(["a", " b ", ""])) === JSON.stringify(["a", "b"]));

/* ================= clozeStrip ================= */
console.log("clozeStrip");
ok("single cloze", T.clozeStrip("我打{{c1::网球}}。") === "我打网球。");
ok("cloze with hint", T.clozeStrip("{{c1::Hund::animal}} bellt") === "Hund bellt");
ok("multiple clozes", T.clozeStrip("{{c1::a}} and {{c2::b}}") === "a and b");
ok("plain text untouched", T.clozeStrip("no cloze here") === "no cloze here");

/* ================= parseInventoryUnexported ================= */
console.log("parseInventoryUnexported");
const inv = [
    "# Inventory — zh", "",
    "**Unique terms:** 3",
    "",
    "| term | first seen | times | anki |",
    "|---|---|---|---|",
    "| `网球` | 2026-07-19 | 3 | ✓ |",
    "| `汉字` | 2026-07-20 | 1 |  |",
    "| `拍子` | 2026-07-21 | 2 |  |",
].join("\n");
const un = T.parseInventoryUnexported(inv);
ok("exported term skipped", !un.includes("网球"));
ok("un-exported terms found", un.includes("汉字") && un.includes("拍子") && un.length === 2);
ok("separator row not a term", !un.includes("---"));
ok("empty doc -> empty list", T.parseInventoryUnexported("").length === 0);

/* ================= vocabNoteBody ================= */
console.log("vocabNoteBody");
const note = T.vocabNoteBody({ term: "汉字", reading: "hànzì", gloss: "character" },
    T.langByVault("zh"), "Boox", "2026-07-23");
ok("type vocab", note.includes("type: vocab"));
ok("language flat key", note.includes("language: zh"));
ok("term quoted", note.includes('term: "汉字"'));
ok("exported_anki starts false", note.includes("exported_anki: false"));
ok("authored, not generated", note.includes("generated: false"));
ok("first_seen stamped", note.includes("first_seen: 2026-07-23"));
ok("reading in the body", note.includes("hànzì"));

// Gap 1: audio/traditional/zhuyin/image are optional per entry/language —
// present when the entry has them, omitted (not blanked) when it doesn't.
const richNote = T.vocabNoteBody({ term: "汉字", reading: "hànzì", gloss: "character",
    traditional: "漢字", zhuyin: "ㄏㄢˋㄗˋ", audio: "hanzi.mp3", image: "hanzi.jpg" },
    T.langByVault("zh"), "Boox", "2026-07-23");
ok("traditional persisted", richNote.includes('traditional: "漢字"'));
ok("zhuyin persisted", richNote.includes('zhuyin: "ㄏㄢˋㄗˋ"'));
ok("audio persisted", richNote.includes('audio: "hanzi.mp3"'));
ok("image persisted", richNote.includes('image: "hanzi.jpg"'));
ok("bare entry (German, say) has no zhuyin/traditional lines",
    !note.includes("zhuyin:") && !note.includes("traditional:")
        && !note.includes("audio:") && !note.includes("image:"));
// The optional-field filter must drop only the four nulls (absent
// audio/traditional/zhuyin/image), not every falsy array element — a naive
// .filter(Boolean) would also swallow the legitimately empty body-content
// line (no reading, no gloss) and the trailing blank line, truncating the
// note right after the heading instead of leaving its blank-line structure
// alone.
const termOnly = T.vocabNoteBody({ term: "你好" }, T.langByVault("zh"), "", "2026-07-23");
ok("term-only note keeps its trailing blank-line structure (filter(Boolean) would strip it)",
    termOnly.endsWith("# 你好\n\n\n"));

/* ================= wordsForPush ================= */
console.log("wordsForPush");
const words = T.wordsForPush([
    { term: "网球", reading: "wǎngqiú", gloss: "tennis" },
    { term: "", reading: "x", gloss: "dropped" },
]);
ok("VocabEntry shape", words.length === 1 && words[0].word === "网球"
    && words[0].trans === "wǎngqiú" && words[0].meaning === "tennis"
    && "audio" in words[0] && "traditional" in words[0] && "zhuyin" in words[0]
    && "image" in words[0]);
ok("blank when absent (still no hardcoded data)",
    words[0].audio === "" && words[0].traditional === "" && words[0].zhuyin === ""
        && words[0].image === "");

const richWords = T.wordsForPush([
    { term: "汉字", reading: "hànzì", gloss: "character", traditional: " 漢字 ",
      zhuyin: "ㄏㄢˋㄗˋ", audio: "hanzi.mp3", image: "hanzi.jpg" },
]);
ok("real values pass through instead of being hardcoded to \"\"",
    richWords[0].traditional === "漢字" && richWords[0].zhuyin === "ㄏㄢˋㄗˋ"
        && richWords[0].audio === "hanzi.mp3" && richWords[0].image === "hanzi.jpg");

/* ================= vocabNotePath ================= */
console.log("vocabNotePath");
ok("em-dash join, sanitized term, folder as given",
    T.vocabNotePath("01 Notes/linguistics/Vocab", "zh", "网球/拍")
        === "01 Notes/linguistics/Vocab/zh — 网球·拍.md");

/* ================= mergeNoteFields ================= */
console.log("mergeNoteFields");
ok("frontmatter fills a field the entry lacks",
    T.mergeNoteFields({ term: "汉字" }, { audio: "hanzi.mp3", traditional: "漢字" })
        .audio === "hanzi.mp3");
ok("entry's own value wins over frontmatter",
    T.mergeNoteFields({ term: "汉字", audio: "session.mp3" }, { audio: "hanzi.mp3" })
        .audio === "session.mp3");
ok("no frontmatter, no entry value -> field stays absent", (() => {
    const m = T.mergeNoteFields({ term: "汉字" }, null);
    return !("audio" in m) && !("traditional" in m);
})());
ok("term/reading/gloss carried through untouched",
    T.mergeNoteFields({ term: "汉字", reading: "hànzì" }, {}).reading === "hànzì");

/* ================= serverDownMessage ================= */
console.log("serverDownMessage");
ok("names the configured LinguaStudio URL",
    T.serverDownMessage("lingua", "http://127.0.0.1:8000").includes("http://127.0.0.1:8000"));
ok("suggests checking Settings",
    /settings/i.test(T.serverDownMessage("lingua", "http://127.0.0.1:8000")));
ok("names the configured vault sidecar URL",
    T.serverDownMessage("vault", "http://127.0.0.1:8749").includes("http://127.0.0.1:8749"));
ok("names the configured AnkiConnect URL",
    T.serverDownMessage("anki", "http://127.0.0.1:8765").includes("http://127.0.0.1:8765"));
ok("unknown kind still names the URL, doesn't throw",
    T.serverDownMessage("mystery", "http://x").includes("http://x"));

/* ================= vocabExportSidecar ================= */
console.log("vocabExportSidecar");
// /vocab/export moved off linguaSidecarUrl onto vaultSidecarUrl (the vault
// sidecar builds the .apkg itself now, per the paired sidecar commit) — this
// is the one place that decision is named, and both real call sites (Vocab
// Studio's Export button, runAnki's export branch) route through it, so a
// future edit that quietly moves it back to "lingua" fails here first.
ok("vocab export routes to the vault sidecar, not LinguaStudio",
    T.vocabExportSidecar({ vaultSidecarUrl: "http://127.0.0.1:8749",
        linguaSidecarUrl: "http://127.0.0.1:8000" }).kind === "vault");
ok("vocab export carries the configured vaultSidecarUrl",
    T.vocabExportSidecar({ vaultSidecarUrl: "http://127.0.0.1:8749" }).base
        === "http://127.0.0.1:8749");

/* ================= lookupFailureNotice ================= */
console.log("lookupFailureNotice");
ok("no failures -> no notice", T.lookupFailureNotice(0, 5) === "");
ok("partial failure -> counted message",
    T.lookupFailureNotice(2, 5) === "2 of 5 term(s) couldn't be looked up just "
        + "now — carried through with blank reading/meaning.");
ok("all failed still reports the count", T.lookupFailureNotice(3, 3).startsWith("3 of 3"));
// Mode-neutral: this Notice fires before the push/export branch runs, so it
// must never assert a push happened when the operator chose Export, or when
// the reason for the failures is the engine being fully down (nothing was
// pushed at all in that case either).
ok("never claims a push happened", !T.lookupFailureNotice(1, 1).includes("pushed"));

/* ================= card registry ================= */
console.log("card registry");
const R = T.CARD_REGISTRY;
ok("37 live builders (the app's nav, nothing more)",
    Object.keys(R.specs).length === 37);
ok("groups are the app's own",
    R.groups.map((g) => g.name).join(",")
        === "Core,Cloze,Skill,Composite,Output,Visual,Depth,Tools,Source");
ok("every grouped type has a spec",
    R.groups.every((g) => g.types.every((t) => !!R.specs[t])));
ok("every spec is reachable from a group",
    Object.keys(R.specs).every((t) => R.groups.some((g) => g.types.includes(t))));
ok("dead contract types are gone",
    ["interest_bridge", "emotion_map", "pubmed", "burst_flash", "delayed_recall",
     "social_script", "cascade_reading", "cascade_writing", "visual_card",
     "matching_game"].every((t) => !R.specs[t]));
ok("language gating carried over from the app",
    R.specs.rhythm.langs.join(",") === "cmn,yue"
        && R.specs.chengyu.langs.join(",") === "cmn"
        && R.specs.hanzi_writer.langs.includes("jpn")
        && !R.specs.listening.langs);
ok("every non-custom spec has fields with keys",
    Object.values(R.specs).every((s) => s.custom
        || (Array.isArray(s.fields) && s.fields.length
            && s.fields.every((f) => f.key && f.label))));
ok("select fields carry options",
    Object.values(R.specs).every((s) => s.fields.every(
        (f) => f.type !== "select" || (f.options && f.options.length))));
ok("cascade is a custom builder, not a flat form",
    R.specs.cascade && R.specs.cascade.custom === "cascade" && !R.specs.cascade_reading);
ok("chengyu spec matches the app's composite",
    R.specs.chengyu.fields.map((f) => f.key).join(",")
        === "idiom,pinyin,meaning,literal,origin");
ok("qa_ladder stages present",
    R.specs.qa_ladder.fields.find((f) => f.key === "stage").options.length === 4);
ok("no spec text carries section citations",
    !JSON.stringify(R).includes("§"));
ok("five app themes, sumi first", T.THEMES.length === 5 && T.THEMES[0] === "sumi");

/* ================= spec helpers ================= */
console.log("spec helpers");
ok("specFor known", T.specFor("rhythm") && T.specFor("rhythm").title.length > 0);
ok("specFor unknown -> null", T.specFor("nope") === null);
const draft = T.draftFromSpec(R.specs.qa_ladder.fields);
ok("draft seeds select with first option", draft.stage === "recall");
ok("draft seeds text as empty", draft.question === "");
const rows = T.linesToRows("网球\n\n汉字  ", R.specs.chengyu);
ok("linesToRows one row per line into the primary field",
    rows.length === 2 && rows[0].idiom === "网球" && rows[1].idiom === "汉字");
ok("linesToRows keeps other keys present", "pinyin" in rows[0]);
const payload = T.batchPayload([{ a: 1, _id: "x", b: "y" }]);
ok("batchPayload strips internal keys",
    payload[0].a === 1 && payload[0].b === "y" && !("_id" in payload[0]));

/* ================= whisper (speech-to-text) helpers ================= */
console.log("whisper helpers");
ok("whisperTooLarge accepts a clip under the ceiling",
    T.whisperTooLarge(1024) === false);
ok("whisperTooLarge rejects a clip over the ceiling",
    T.whisperTooLarge(T.MAX_WHISPER_AUDIO_BYTES + 1) === true);
ok("whisperTooLarge is exclusive at the boundary",
    T.whisperTooLarge(T.MAX_WHISPER_AUDIO_BYTES) === false);
ok("whisperMime prefers File.type when present",
    T.whisperMime({ type: "audio/ogg", name: "clip.mp3" }) === "audio/ogg");
ok("whisperMime falls back to the extension when type is empty",
    T.whisperMime({ type: "", name: "clip.MP3" }) === "audio/mpeg");
ok("whisperMime falls back for m4a",
    T.whisperMime({ type: "", name: "lecture.m4a" }) === "audio/mp4");
ok("whisperMime is empty for an unrecognized/missing extension",
    T.whisperMime({ type: "", name: "clip" }) === "");
ok("whisperMime handles a missing file gracefully",
    T.whisperMime(null) === "");
ok("bytesToBase64 round-trips a short buffer",
    T.bytesToBase64(new Uint8Array([72, 101, 108, 108, 111])) === "SGVsbG8=");
ok("bytesToBase64 handles a chunk-boundary-sized buffer without dropping bytes",
    (() => {
        const n = 0x8000 + 10; // just past one chunk, exercises the loop boundary
        const bytes = new Uint8Array(n);
        for (let i = 0; i < n; i++) bytes[i] = i % 256;
        const decoded = Buffer.from(T.bytesToBase64(bytes), "base64");
        return decoded.length === n && decoded[0] === 0 && decoded[n - 1] === (n - 1) % 256;
    })());
ok("whisperText extracts and trims text from a successful response",
    T.whisperText({ ok: true, text: "  hello world  " }) === "hello world");
ok("whisperText is empty on ok:false",
    T.whisperText({ ok: false, error: "boom" }) === "");
ok("whisperText is empty on a missing/null response",
    T.whisperText(null) === "" && T.whisperText(undefined) === "");

/* ================= new sections + helpers ================= */
console.log("sections");
ok("sections include tts, sentences, manage",
    T.SECTIONS.includes("tts") && T.SECTIONS.includes("sentences")
        && T.SECTIONS.includes("manage"));
ok("pack kinds cover dict + sentences",
    T.PACK_KINDS.dict && T.PACK_KINDS.sentences
        && T.PACK_KINDS.dict.del === "/dict"
        && T.PACK_KINDS.sentences.del === "/sentences");

console.log("tts voice helpers");
ok("voice id from object prefers display id",
    T.ttsVoiceId({ id: "Xiaoxiao", ShortName: "zh-CN-XiaoxiaoNeural" }) === "Xiaoxiao");
ok("voice id from bare string", T.ttsVoiceId("Aria") === "Aria");
ok("voice id falls back to ShortName",
    T.ttsVoiceId({ ShortName: "zh-CN-YunyangNeural" }) === "zh-CN-YunyangNeural");
ok("voice label carries locale + gender",
    T.ttsVoiceLabel({ name: "Xiaoxiao", locale: "zh-CN", gender: "Female" })
        === "Xiaoxiao (zh-CN) · Female");
ok("audio b64 reads audioB64 (vocab/audio shape)",
    T.ttsAudioB64({ ok: true, audioB64: "abc123" }) === "abc123");
ok("audio b64 reads audio (tts/preview shape)",
    T.ttsAudioB64({ ok: true, audio: "def456" }) === "def456");
ok("audio b64 prefers audioB64 when both are present",
    T.ttsAudioB64({ audioB64: "first", audio: "second" }) === "first");
ok("audio b64 empty on null/non-object response",
    T.ttsAudioB64(null) === "" && T.ttsAudioB64(undefined) === "");

// The two endpoints disagree on the field name, and reading only one of them
// is what left Preview permanently silent.
ok("audio from /vocab/audio's audioB64", T.ttsAudioB64({ ok: true, audioB64: "AAA" }) === "AAA");
ok("audio from /tts/preview's audio", T.ttsAudioB64({ ok: true, audio: "BBB" }) === "BBB");
ok("audioB64 wins when both are present", T.ttsAudioB64({ audioB64: "AAA", audio: "BBB" }) === "AAA");
ok("no audio field yields empty", T.ttsAudioB64({ ok: true }) === "");
ok("null response yields empty", T.ttsAudioB64(null) === "");

console.log("sentence helpers");
ok("sentence text from {text}", T.sentenceText({ text: "我喜欢猫", translation: "I like cats" }) === "我喜欢猫");
ok("sentence text from {sentence}", T.sentenceText({ sentence: "你好" }) === "你好");
ok("sentence text from string", T.sentenceText("裸句") === "裸句");
ok("sentence gloss from {translation}", T.sentenceGloss({ text: "x", translation: "hi" }) === "hi");
ok("sentence gloss empty when none", T.sentenceGloss({ text: "x" }) === "");

console.log("pack status");
ok("progress -> busy",
    T.packStatus({ name: "German", progress: 42 }).busy === true);
ok("downloaded -> installed",
    T.packStatus({ name: "German", downloaded: true }).installed === true);
ok("plain available -> not installed, not busy", (() => {
    const s = T.packStatus({ name: "French", status: "available" });
    return !s.installed && !s.busy && s.label === "available";
})());
ok("status installed string -> installed",
    T.packStatus({ lang: "spa", status: "installed" }).installed === true);

/* ================= cascade ================= */
console.log("cascade");
ok("sections include vocab + settings",
    T.SECTIONS.includes("vocab") && T.SECTIONS.includes("settings"));
ok("meter count from meter string",
    T.cascadeMeterCount("4/4") === 4 && T.cascadeMeterCount("3/4") === 3
        && T.cascadeMeterCount("6/8") === 6);
const bc = JSON.parse(T.cascadeBeatConfig(
    { meter: "3/4", ttsBeats: [1, 4], subdiv: 2, gapCycles: 1, randomize: true,
      dispMode: "sentence" }, "cmn"));
ok("beat_config clamps beats to the meter count", JSON.stringify(bc.beats) === "[1]");
ok("beat_config carries count/meter/rand/subdivisions/gapCycles/lang",
    bc.count === 3 && bc.meter === "3/4" && bc.rand === true
        && bc.subdivisions === 2 && bc.gapCycles === 1 && bc.lang === "cmn");
ok("beat_config emits cascadeMode only when not auto", bc.cascadeMode === "sentence");
ok("beat_config omits cascadeMode on auto",
    !("cascadeMode" in JSON.parse(T.cascadeBeatConfig(
        { meter: "4/4", ttsBeats: [1], dispMode: "auto" }, "cmn"))));
const jobs = T.cascadeJobs([
    { mode: "reading", title: "P1", text: "one two three", wpm: 150 },
    { mode: "cascade", title: "W1", text: "你好 谢谢", bpm: 90, pattern: "cross",
      meter: "4/4", ttsBeats: [1], subdiv: 1, gapCycles: 0, writingOn: true,
      writeEvery: 2, timeLimit: 20, metroWrite: false, strokeDemo: true,
      showOutline: true },
], "cmn");
const jobMap = Object.fromEntries(jobs);
ok("mixed batch splits into two card-type jobs", jobs.length === 2);
ok("reading job shape", jobMap.cascade_reading[0].passage === "one two three"
    && jobMap.cascade_reading[0].wpm === 150);
ok("cascade job carries beat_config + writing fields",
    typeof jobMap.cascade[0].beat_config === "string"
        && jobMap.cascade[0].every === 2 && jobMap.cascade[0].timeLimit === 20
        && jobMap.cascade[0].strokeDemo === true);
ok("writing off -> every:0, no writing extras", (() => {
    const j = T.cascadeJobs([{ mode: "cascade", title: "x", text: "a", bpm: 80,
        pattern: "cross", meter: "4/4", ttsBeats: [1], writingOn: false }], "cmn");
    const c = Object.fromEntries(j).cascade[0];
    return c.every === 0 && !("timeLimit" in c);
})());

/* ================= vocab templates ================= */
console.log("vocab templates");
ok("five base templates + Visual",
    T.VOCAB_BASE_TEMPLATES.length === 5 && T.VOCAB_ALL_TEMPLATES.includes("Visual"));
ok("classic default (all 5 base) sends empty list",
    T.vocabTemplateList(T.VOCAB_BASE_TEMPLATES).length === 0);
ok("a subset sends the list",
    JSON.stringify(T.vocabTemplateList(["Meaning", "Writing"])) === '["Meaning","Writing"]');
ok("adding Visual sends the full list",
    T.vocabTemplateList([...T.VOCAB_BASE_TEMPLATES, "Visual"]).length === 6);

/* ================= buildLayout ================= */
console.log("buildLayout");
const layout = T.buildLayout("de");
const mainLeaf = layout.main.children[0].children[0];
const navLeaf = layout.left.children[0].children[0];
ok("main pane is the workbench", mainLeaf.state.type === T.MAIN_VIEW);
ok("workbench opens on the chosen language", mainLeaf.state.state.lang === "de");
ok("left rail is the nav view", navLeaf.state.type === T.NAV_VIEW);
ok("workbench is active", layout.active === mainLeaf.id);
ok("right sidebar collapsed", layout.right.collapsed === true);
ok("workspace name is Lingua", T.WORKSPACE_NAME === "Lingua");

/* ================= vocab store (spec §10 rewrite, Stage 3.6) =================
 * The plugin no longer stores word data (trans/meaning/traditional/zhuyin) —
 * that lives in the sidecar's shared CSV now. What's tested here is the part
 * that stayed local: the batch-selection store, its one-time legacy-shape
 * migration, and that "Remove"/"Clear" never reach the CSV. Instantiated
 * directly against the module's default export (the plugin class itself,
 * same object `T` was pulled off of) rather than reimplementing the logic,
 * so this cannot drift from what actually runs. */
console.log("vocab store");
(async () => {
    const LinguaWorkspacePlugin = require(path.join(__dirname, "..", "main.js"));
    function makePlugin(vocabSeed) {
        const p = new LinguaWorkspacePlugin();
        p.data = { vocab: vocabSeed || {} };
        p.settings = { vaultSidecarUrl: "http://TEST" };
        p.saveData = async () => {};
        return p;
    }

    // Legacy `.words` (array of lookup-result objects) reshapes into `.terms`
    // (array of strings) + `_legacyWords` (kept until migrated), in place, on
    // first access — this is the exact shape 62 real notes migrated through
    // in production today, so silently dropping a term here is a real loss.
    {
        const p = makePlugin({ zh: { words: [
            { word: "分享", trans: "", meaning: "to share", audio: "" },
            { word: "大家", trans: "", meaning: "everyone", audio: "a.mp3" },
        ], selected: ["Reading"] } });
        const v = p._vocab("zh");
        ok("legacy .words reshapes into .terms", v.terms.length === 2
            && v.terms.includes("分享") && v.terms.includes("大家"));
        ok("legacy .words is kept as _legacyWords, not discarded", v._legacyWords
            && v._legacyWords.length === 2);
        ok("the .words key itself is gone (not left as dead weight)", !("words" in v));
        ok("unrelated fields (.selected) survive the reshape untouched",
            v.selected.length === 1 && v.selected[0] === "Reading");
        // Re-accessing must be idempotent: it must not duplicate terms or
        // re-derive from a `.words` array that no longer exists.
        const v2 = p._vocab("zh");
        ok("re-accessing is idempotent", v2.terms.length === 2 && v2 === v);
    }

    // addVocabTerm: dedups locally, and — critically — still adds the term to
    // the LOCAL batch even when the sidecar upsert throws. A capture made
    // while the sidecar is down must not be silently lost.
    {
        const shimObs = require("obsidian");
        const origRequestUrl = shimObs.requestUrl;
        const p = makePlugin();
        shimObs.requestUrl = async () => ({ status: 200, json: { row: { term: "分享" } } });
        await p.addVocabTerm("zh", "分享");
        await p.addVocabTerm("zh", "分享");  // duplicate add
        ok("addVocabTerm dedups", p._vocab("zh").terms.length === 1);

        shimObs.requestUrl = async () => { throw new Error("sidecar down"); };
        await p.addVocabTerm("zh", "大家");
        ok("addVocabTerm still adds locally when the sidecar upsert fails",
            p._vocab("zh").terms.includes("大家"));
        shimObs.requestUrl = origRequestUrl;
    }

    // removeVocabTerm / clearVocab operate on the LOCAL selection only — this
    // is the load-bearing guarantee that "Remove"/"Clear" in the UI can never
    // delete a CSV row (tracked vocabulary other stages depend on). There is
    // no network call in either path — asserted by never touching requestUrl.
    {
        const shimObs = require("obsidian");
        const origRequestUrl = shimObs.requestUrl;
        let networkCalls = 0;
        shimObs.requestUrl = async () => { networkCalls++; return { status: 200, json: {} }; };
        const p = makePlugin({ zh: { terms: ["分享", "大家", "快乐"], selected: [] } });
        await p.removeVocabTerm("zh", "大家");
        ok("removeVocabTerm removes the named term",
            !p._vocab("zh").terms.includes("大家") && p._vocab("zh").terms.length === 2);
        await p.clearVocab("zh");
        ok("clearVocab empties the batch", p._vocab("zh").terms.length === 0);
        ok("neither remove nor clear ever calls the sidecar", networkCalls === 0);
        shimObs.requestUrl = origRequestUrl;
    }

    // migrateVocabToCsv: only drops `_legacyWords` when EVERY word migrated —
    // a partial failure must leave the unmigrated words recoverable on the
    // next attempt, not silently forget which ones failed.
    {
        const shimObs = require("obsidian");
        const origRequestUrl = shimObs.requestUrl;
        const p = makePlugin({ zh: { words: [
            { word: "分享", audio: "" }, { word: "大家", audio: "a.mp3" },
        ], selected: [] } });
        p._vocab("zh"); // trigger the reshape so _legacyWords exists
        let calls = 0;
        shimObs.requestUrl = async () => {
            calls++;
            if (calls === 2) throw new Error("sidecar down mid-migration");
            return { status: 200, json: { created: true } };
        };
        const r = await p.migrateVocabToCsv("zh");
        ok("partial failure is reported, not swallowed", r.migrated === 1 && r.failed === 1);
        ok("a partial failure keeps _legacyWords for the next attempt",
            !!p._vocab("zh")._legacyWords);

        shimObs.requestUrl = async () => ({ status: 200, json: { created: true } });
        const r2 = await p.migrateVocabToCsv("zh");
        ok("a clean run migrates everything", r2.failed === 0);
        ok("a clean run drops _legacyWords", !p._vocab("zh")._legacyWords);
        shimObs.requestUrl = origRequestUrl;
    }
})().then(() => {
    console.log(`\nlingua-workspace: ${passed} assertions passed`);
}).catch((e) => {
    console.error(e);
    process.exitCode = 1;
});

/* ================= 6.1/6.2: review + stats sections ================= */
console.log("review + stats sections");
ok("SECTIONS gained review and stats (6.1's route audit: the two doorways lingua-workspace lacked)",
    T.SECTIONS.includes("review") && T.SECTIONS.includes("stats"));
ok("both have labels (a section with no label renders a blank tab)",
    !!T.SECTION_LABELS.review && !!T.SECTION_LABELS.stats);

console.log("summarizeVocabRows");
{
    const rows = [
        { status_receptive: "known", status_productive: "known", ignored: false },
        { status_receptive: "known", status_productive: "learning", ignored: false },
        { status_receptive: "learning", status_productive: "unknown", ignored: false },
        { status_receptive: "seen", status_productive: "unknown", ignored: false },
        { status_receptive: "", status_productive: "", ignored: true },       // unset -> unknown
        { status_receptive: "unknown", status_productive: "unknown", ignored: "true" },
    ];
    const s = T.summarizeVocabRows(rows);
    ok("total counts every row", s.total === 6);
    ok("known counted", s.known === 2);
    ok("learning counted", s.learning === 1);
    ok("seen counted", s.seen === 1);
    ok("an unset status_receptive counts as unknown, not dropped", s.unknown === 2);
    ok("productive counts learning+known on the productive track", s.productive === 2);
    ok("ignored counts both boolean true and the string \"true\" (raw CSV read)", s.ignored === 2);

    ok("empty input yields all-zero counts, not a throw",
        JSON.stringify(T.summarizeVocabRows([])) ===
        JSON.stringify({ total: 0, unknown: 0, seen: 0, learning: 0, known: 0, productive: 0, ignored: 0 }));
    ok("undefined input is tolerated the same way", T.summarizeVocabRows(undefined).total === 0);
}

console.log("ocrPackFor (which tesseract pack OCRs which language)");
{
    /* The bug this replaced: `this.lang.vault === "zh" ? "chi_sim" : "eng"`.
       LANGS gained zh-hans / zh-hant / yue, so picking "Chinese (Simplified)"
       gave vault code "zh-hans", which is NOT "zh" — and Chinese pages were
       OCR'd with the ENGLISH pack, silently, returning garbage with no error.
       This is the === comparison the vault's CLAUDE.md forbids outright. */
    ok("plain zh still maps to Simplified Chinese", T.ocrPackFor("zh") === "chi_sim");
    ok("zh-hans maps to Chinese, NOT English (the whole bug)",
        T.ocrPackFor("zh-hans") === "chi_sim");
    ok("zh-hant maps to Chinese too", T.ocrPackFor("zh-hant") === "chi_sim");
    ok("Cantonese uses the Traditional pack — tesseract has no yue",
        T.ocrPackFor("yue") === "chi_tra");
    ok("Japanese and Korean get their own packs",
        T.ocrPackFor("ja") === "jpn" && T.ocrPackFor("ko") === "kor");
    ok("Arabic, German and Russian map to their packs",
        T.ocrPackFor("ar") === "ara" && T.ocrPackFor("de") === "deu"
        && T.ocrPackFor("ru") === "rus");
    ok("a case-varied tag still resolves (tags are matched lowercased)",
        T.ocrPackFor("ZH-Hans") === "chi_sim");
    // Negative controls: the fallback must be a real decision, not an accident.
    ok("an unknown language falls back to English rather than throwing",
        T.ocrPackFor("xx") === "eng");
    ok("an empty or missing code falls back to English",
        T.ocrPackFor("") === "eng" && T.ocrPackFor(undefined) === "eng");
    ok("English maps to English (positive control: the table is consulted)",
        T.ocrPackFor("en") === "eng");

    /* isMandarinLang gates the HSK column and filter. Same bug, second site:
       `=== "zh"` hid HSK from anyone who picked "Chinese (Simplified)". */
    ok("HSK shows for plain zh", T.isMandarinLang("zh") === true);
    ok("…and for zh-hans and zh-hant (the bug)",
        T.isMandarinLang("zh-hans") === true && T.isMandarinLang("zh-hant") === true);
    ok("…but NOT for Cantonese, which has no HSK",
        T.isMandarinLang("yue") === false);
    ok("…nor for unrelated languages",
        T.isMandarinLang("ja") === false && T.isMandarinLang("en") === false
        && T.isMandarinLang("") === false);

    /* THE GUARD THAT KEEPS THIS FIXED. Every vault code in LANGS must resolve
       through the table. A new language added without an OCR_PACKS row fails
       HERE, loudly, instead of silently OCRing in English the way zh-hans did
       for weeks. */
    const missing = T.LANGS
        .map((l) => l.vault)
        .filter((v) => !Object.prototype.hasOwnProperty.call(T.OCR_PACKS, T.ocrBaseLang(v)));
    ok("every LANGS entry has an OCR pack — a new language cannot be forgotten: "
        + (missing.length ? missing.join(", ") : "none missing"), missing.length === 0);
}

/* ================= v4 batch logic =================
 * Pure model for the word-batch workbench (v4 design contract): word flags,
 * rules, card list, field mapping, engine payload. No Obsidian, no network.
 * The DOM screens render these values; they never recompute them. */
console.log("v4 batch logic");

function v4Batch(over) {
    return Object.assign({
        id: "b1", name: "Test", source: "Typed", lang: "zh",
        words: [
            T.v4MakeWord("苹果", { P: "píng guǒ", M: "apple", audio: "Forvo" }),
            T.v4MakeWord("打", { P: "dǎ", senses: ["to hit", "to play"], audio: "" }),
        ],
        outs: [{ type: "vocab", tpls: [0, 1, 2, 3, 4], themes: null, def: null, sub: "Vocab" }],
        themes: ["sumi", "washi"], def: "sumi", deck: "LinguaStudio::Test",
        flags: {}, rules: [], ov: {},
    }, over || {});
}

console.log("v4WordLang + v4NewBatch");
ok("german vault code is an _ls_lang code", T.v4WordLang("de") === "de");
ok("cantonese passes through", T.v4WordLang("yue") === "yue");
ok("mandarin falls back to generic", T.v4WordLang("zh") === "xx" && T.v4WordLang("zh-hans") === "xx");
ok("english falls back to generic", T.v4WordLang("en") === "xx");
{
    const nb = T.v4NewBatch("HSK 3", "zh", "Frequency list");
    ok("new batch carries name/lang/source", nb.name === "HSK 3" && nb.lang === "zh" && nb.source === "Frequency list");
    ok("new batch starts with a full vocab out", nb.outs.length === 1 && nb.outs[0].type === "vocab"
        && JSON.stringify(nb.outs[0].tpls) === "[0,1,2,3,4]");
    ok("new batch starts wordless", nb.words.length === 0);
}
ok("audio tag uses the engine <lingua>-<word>.mp3 convention",
    T.v4AudioTag({ S: "苹果", audio: "Forvo" }, { lang: "zh" }) === "[sound:cmn-苹果.mp3]");
ok("no audio source -> empty tag", T.v4AudioTag({ S: "x", audio: "" }, { lang: "de" }) === "");

console.log("v4MakeWord");
{
    const a = T.v4MakeWord("苹果");
    const b = T.v4MakeWord("苹果");
    ok("word carries the term", a.S === "苹果");
    ok("reading/meaning default empty, senses empty", a.P === "" && a.M === "" && Array.isArray(a.senses) && a.senses.length === 0);
    ok("confidence defaults to 1 (typed)", a.conf === 1);
    ok("ids are unique", a.id !== b.id);
    ok("overrides apply", T.v4MakeWord("x", { P: "p", src: "Boox", conf: 0.6 }).src === "Boox");
}

console.log("v4ToneOf");
ok("tone 1 (ā)", T.v4ToneOf("mā") === 1);
ok("tone 2 (á)", T.v4ToneOf("má") === 2);
ok("tone 3 (ǎ)", T.v4ToneOf("dǎ") === 3);
ok("tone 4 (à)", T.v4ToneOf("mà") === 4);
ok("neutral (a) is 5", T.v4ToneOf("ma") === 5);

console.log("v4FlagsOf");
ok("complete word has no flags",
    T.v4FlagsOf({ S: "苹果", P: "píng guǒ", M: "apple", senses: [], audio: "Forvo", conf: 1 }).length === 0);
ok("no reading -> missing",
    T.v4FlagsOf({ S: "x", P: "", M: "m", senses: [], audio: "a", conf: 1 }).includes("missing"));
ok("unpicked multi-sense word -> senses (meaning is pickable, not missing)",
    (() => { const f = T.v4FlagsOf({ S: "打", P: "dǎ", M: "", senses: ["to hit", "to play"], audio: "a", conf: 1 });
        return !f.includes("missing") && f.includes("senses"); })());
ok("no reading and no senses -> missing",
    T.v4FlagsOf({ S: "x", P: "", M: "", senses: [], audio: "a", conf: 1 }).includes("missing"));
ok("picked meaning clears both",
    T.v4FlagsOf({ S: "打", P: "dǎ", M: "to hit", senses: ["to hit", "to play"], audio: "a", conf: 1 }).length === 0);
ok("no audio -> audio flag", T.v4FlagsOf({ S: "x", P: "p", M: "m", senses: [], audio: "", conf: 1 }).includes("audio"));
ok("low confidence -> conf flag", T.v4FlagsOf({ S: "x", P: "p", M: "m", senses: [], audio: "a", conf: 0.6 }).includes("conf"));

console.log("v4CondHit");
{
    const w = { S: "苹果", P: "píng guǒ", M: "apple", senses: [], audio: "Forvo", src: "HSK 3", conf: 1 };
    ok("chars counts code points", T.v4CondHit({ cond: "chars", val: "1" }, w) === true
        && T.v4CondHit({ cond: "chars", val: "2" }, w) === false);
    ok("src matches case-insensitively", T.v4CondHit({ cond: "src", val: "hsk 3" }, w) === true);
    ok("senses needs several", T.v4CondHit({ cond: "senses" }, w) === false
        && T.v4CondHit({ cond: "senses" }, { S: "x", senses: ["a", "b"] }) === true);
    ok("noaudio is the absence of audio", T.v4CondHit({ cond: "noaudio" }, w) === false
        && T.v4CondHit({ cond: "noaudio" }, { S: "x", audio: "" }) === true);
    ok("tone3 reads the pinyin (dǎ is third tone, chī fàn is not)",
        T.v4CondHit({ cond: "tone3" }, { S: "打", P: "dǎ" }) === true
        && T.v4CondHit({ cond: "tone3" }, { S: "吃饭", P: "chī fàn" }) === false);
}

console.log("v4RuleText");
ok("skip rule names the template",
    T.v4RuleText({ cond: "chars", val: "2", act: "skip", aval: "Writing" })
        === "If the word has more than 2 characters, skip the template \"Writing\"");
ok("theme rule names the theme id",
    T.v4RuleText({ cond: "src", val: "Boox", act: "theme", aval: "washi" }).includes("washi"));
ok("tag rule hashes the tag",
    T.v4RuleText({ cond: "src", val: "Boox", act: "tag", aval: "boox" }).includes("#boox"));

console.log("v4EffMeaning");
{
    const w = { S: "打", P: "dǎ", M: "", senses: ["to hit", "to play"] };
    ok("picked meaning wins", T.v4EffMeaning({ S: "x", M: "m", senses: ["a", "b"] }, v4Batch()) === "m");
    ok("live sense1 rule fills the first sense",
        T.v4EffMeaning(w, v4Batch({ rules: [{ id: "r", on: 1, cond: "senses", val: "", act: "sense1", aval: "" }] })) === "to hit");
    ok("sense1 rule off -> still blank",
        T.v4EffMeaning(w, v4Batch({ rules: [{ id: "r", on: 0, cond: "senses", val: "", act: "sense1", aval: "" }] })) === "");
}

console.log("v4Cards");
{
    const b = v4Batch({ rules: [{ id: "r1", on: 1, cond: "chars", val: "1", act: "skip", aval: "Writing" }] });
    const cards = T.v4Cards(b);
    ok("vocab out x 5 templates x 2 words = 10 cards", cards.length === 10);
    ok("card keys are unique", new Set(cards.map((c) => c.key)).size === 10);
    const writingApple = cards.find((c) => c.w.S === "苹果" && c.ti === 3);
    const writingDa = cards.find((c) => c.w.S === "打" && c.ti === 3);
    ok("rule fires per word (苹果 2 chars skipped, 打 1 char kept)",
        !!writingApple.ruleSkip && !writingDa.ruleSkip);
    ok("tag rules land on the card",
        T.v4Cards(v4Batch({ rules: [{ id: "r", on: 1, cond: "src", val: "Typed", act: "tag", aval: "boox" }] }))
            .every((c) => c.tags.includes("boox")));
    ok("unknown out types are skipped, not thrown",
        T.v4Cards(v4Batch({ outs: [{ type: "nope", tpls: [0], sub: "x" }] })).length === 0);
}
{
    const words = [];
    for (let i = 0; i < 7; i++) words.push(T.v4MakeWord("w" + i, { P: "p", M: "m", audio: "a" }));
    const mc = T.v4Cards(v4Batch({ words, outs: [{ type: "matching", tpls: [0], themes: null, def: null, sub: "Match" }] }));
    ok("matching packs 6 per board (7 words -> 2 notes)", mc.length === 2 && mc[0].ws.length === 6 && mc[1].ws.length === 1);
    const cc = T.v4Cards(v4Batch({ words: words.concat([T.v4MakeWord("w7", { P: "p", M: "m", audio: "a" }), T.v4MakeWord("w8", { P: "p", M: "m", audio: "a" })]),
        outs: [{ type: "cflash", tpls: [0], themes: null, def: null, sub: "Flash" }] }));
    ok("cascade packs 8 per note (9 words -> 2 notes)", cc.length === 2 && cc[0].ws.length === 8 && cc[1].ws.length === 1);
}

console.log("v4Skipped + v4ThemeOf");
{
    const b = v4Batch({ rules: [{ id: "r1", on: 1, cond: "chars", val: "1", act: "skip", aval: "Writing" }] });
    const cards = T.v4Cards(b);
    const sk = cards.find((c) => c.w.S === "苹果" && c.ti === 3);
    const kept = cards.find((c) => c.w.S === "打" && c.ti === 3);
    ok("rule-skipped by default", T.v4Skipped(b, sk) === true && T.v4Skipped(b, kept) === false);
    const forced = Object.assign({}, b, { ov: { [sk.key]: { inc: 1 } } });
    ok("per-card include overrides the rule", T.v4Skipped(forced, sk) === false);
    const banned = Object.assign({}, b, { ov: { [kept.key]: { inc: 0 } } });
    ok("per-card skip removes a kept card", T.v4Skipped(banned, kept) === true);
    ok("theme falls back to the batch default", T.v4ThemeOf(b, kept) === "sumi");
    const ruled = Object.assign({}, b, { rules: [{ id: "r", on: 1, cond: "src", val: "Typed", act: "theme", aval: "washi" }] });
    const rc = T.v4Cards(ruled).find((c) => c.w.S === "打" && c.ti === 0);
    ok("rule theme beats the batch default", T.v4ThemeOf(ruled, rc) === "washi");
    const over = Object.assign({}, ruled, { ov: { [rc.key]: { theme: "paper" } } });
    ok("per-card theme beats the rule", T.v4ThemeOf(over, rc) === "paper");
}

console.log("v4RowFor");
{
    const b = v4Batch();
    const cards = T.v4Cards(b);
    const vr = T.v4RowFor(b, cards.find((c) => c.w.S === "苹果" && c.ti === 0));
    ok("vocab maps the word fields", vr.Simplified === "苹果" && vr.Pinyin === "píng guǒ" && vr.Meaning === "apple");
    ok("audio emits a sound tag when the word has a source", vr.Audio === "[sound:cmn-苹果.mp3]");
    ok("no audio source -> empty audio",
        T.v4RowFor(b, cards.find((c) => c.w.S === "打" && c.ti === 0)).Audio === "");
    const edited = Object.assign({}, b, { ov: { [cards[0].key]: { f: { Meaning: "APPLE!" } } } });
    ok("per-card field edits layer over the word", T.v4RowFor(edited, cards[0]).Meaning === "APPLE!");
    const wb = v4Batch({ lang: "de", outs: [{ type: "word", tpls: [0], themes: null, def: null, sub: "W" }] });
    const wr = T.v4RowFor(wb, T.v4Cards(wb)[0]);
    ok("word rows carry the _ls_lang code", wr.Language === "de" && wr.Word === "苹果");
    const cb = v4Batch({ lang: "de", outs: [{ type: "concept", tpls: [0], themes: null, def: null, sub: "C" }] });
    const cr = T.v4RowFor(cb, T.v4Cards(cb)[0]);
    ok("concept rows default Kind to a valid engine kind", cr.Kind === "definition" && cr.Front === "苹果");
}

console.log("v4WriteCfg");
{
    const b = v4Batch();
    const wc = JSON.parse(T.v4WriteCfg(b, b.outs[0], "sumi"));
    ok("allow-list + default", JSON.stringify(wc.themes) === '["sumi","washi"]' && wc.theme === "sumi");
    ok("empty batch themes -> empty string", T.v4WriteCfg(v4Batch({ themes: [], def: "" }), { themes: null, def: null }, "") === "");
    ok("per-card theme replaces the default, keeps the list",
        JSON.parse(T.v4WriteCfg(b, b.outs[0], "paper")).theme === "paper");
}

console.log("v4BatchToFamilyGroups");
{
    const b = v4Batch({
        lang: "de",
        outs: [
            { type: "vocab", tpls: [0, 1, 2, 3, 4], themes: null, def: null, sub: "Vocab" },
            { type: "word", tpls: [0], themes: null, def: null, sub: "W" },
        ],
        rules: [{ id: "r1", on: 1, cond: "chars", val: "1", act: "skip", aval: "Writing" }],
    });
    const { groups, errors } = T.v4BatchToFamilyGroups(b);
    ok("no errors on a clean batch", errors.length === 0);
    ok("one group per out", groups.length === 2);
    ok("vocab maps to the LinguaStudio family", groups[0].family === "LinguaStudio");
    ok("word maps to the Word family", groups[1].family === "LinguaStudio_Word");
    ok("deck nests the subdeck", groups[0].deck === "LinguaStudio::Test::Vocab");
    ok("note count matches cards", groups[0].notes.length === 10 && groups[1].notes.length === 2);
    const skippedNote = groups[0].notes.find((n) => n.fields.Simplified === "苹果" && n.skip.length);
    ok("skips use engine template names, not indexes",
        !!skippedNote && skippedNote.skip[0] === "Writing");
    ok("word notes carry the language code", groups[1].notes.every((n) => n.fields.Language === "de"));
    ok("WriteCfg rides on families that have the field",
        groups.every((g) => g.notes.every((n) => typeof n.fields.WriteCfg === "string" && n.fields.WriteCfg.includes("sumi"))));
}
{
    const timed = v4Batch({ outs: [{ type: "timed", tpls: [0], themes: null, def: null, sub: "T" }] });
    const r = T.v4BatchToFamilyGroups(timed);
    ok("timed (no v2 family) lands in errors, never silently dropped",
        r.groups.length === 0 && r.errors.length === 1);
    const bad = v4Batch({ outs: [{ type: "nope", tpls: [0], themes: null, def: null, sub: "x" }] });
    ok("unknown out types error, not throw", T.v4BatchToFamilyGroups(bad).errors.length === 1);
}
{
    // Drift guard: every field key the mapper emits must exist on the engine
    // family. The lists themselves are cross-checked against
    // linguastudio/card_families.py by hand (see the validation script in the
    // session notes) — this guard catches mapper typos, not engine changes.
    const words = [];
    for (let i = 0; i < 8; i++) words.push(T.v4MakeWord("w" + i, { P: "p", M: "m", audio: "a", Sent: "s", T: "t", Z: "z" }));
    for (const type of Object.keys(T.V4_WT_TO_FAMILY)) {
        const t = T.V4_WT.find((x) => x.id === type);
        const b = v4Batch({ lang: "de", words, outs: [{ type, tpls: t.tpls.map((_, i) => i), themes: null, def: null, sub: "S" }],
            flags: { SensoryMute: 1, DyslexiaMode: 1, MicroSteps: 1, MetronomeOverlay: 1 } });
        const { groups, errors } = T.v4BatchToFamilyGroups(b);
        ok(type + " builds without errors", errors.length === 0);
        const known = T.V4_FAMILY_FIELDS[groups[0].family];
        const badKeys = groups[0].notes.flatMap((n) => Object.keys(n.fields).filter((k) => !known.includes(k)));
        ok(type + " emits only known family fields" + (badKeys.length ? ": " + badKeys.join(",") : ""), badKeys.length === 0);
    }
}
