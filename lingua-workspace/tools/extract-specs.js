/* Extract declarative builder specs (FIELDS/COLUMNS/cardType/defaultDeck/
   title/description) from LinguaStudio's composite JSX files into JSON.
   Usage: node extract-specs.js /path/to/lingua-studio */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = process.argv[2];
const dirs = [
    path.join(repo, "src/components/builders"),
    path.join(repo, "src/components/Cloze"),
    path.join(repo, "src/components/Vocab"),
    path.join(repo, "src/components/Cascade"),
    path.join(repo, "src/components/Podcast"),
    path.join(repo, "src/components/QALadder"),
];

function balanced(src, start, open, close) {
    let depth = 0, i = start;
    for (; i < src.length; i++) {
        if (src[i] === open) depth++;
        else if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
    }
    return null;
}

function extractArray(src, name) {
    const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\[`));
    if (!m) return null;
    const text = balanced(src, m.index + m[0].length - 1, "[", "]");
    if (!text) return null;
    try {
        return vm.runInNewContext("(" + text + ")", {});
    } catch (e) {
        return { __error: String(e.message), __raw: text.slice(0, 200) };
    }
}

const out = {}, problems = [];
for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith("Composite.jsx")) continue;
        const src = fs.readFileSync(path.join(dir, f), "utf8");
        const ct = (src.match(/cardType:\s*'([^']+)'/) || [])[1];
        if (!ct) { problems.push(`${f}: no cardType`); continue; }
        const fields = extractArray(src, "FIELDS");
        const columns = extractArray(src, "COLUMNS");
        const deck = (src.match(/defaultDeck:\s*'([^']+)'/) || [])[1] || "";
        const title = (src.match(/title="([^"]+)"/) || [])[1] || ct;
        const desc = (src.match(/description="([^"]+)"/) || [])[1] || "";
        const primary = (src.match(/primary="([^"]+)"/) || [])[1] || "";
        if (!fields || fields.__error) {
            problems.push(`${f} (${ct}): FIELDS ${fields ? fields.__error : "missing"}`);
            continue;
        }
        out[ct] = { title, description: desc, deck, primary,
            fields, columns: (columns && !columns.__error) ? columns : [] };
    }
}
fs.writeFileSync(process.argv[3] || "/dev/stdout",
    JSON.stringify({ specs: out, problems }, null, 1));
console.error(`extracted ${Object.keys(out).length} specs; ${problems.length} problems`);
problems.forEach((p) => console.error("  ! " + p));
