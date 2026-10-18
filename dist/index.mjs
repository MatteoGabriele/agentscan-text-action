import { appendFileSync, readFileSync } from "node:fs";
//#region ../interlinked/packages/interlinked/dist/index.mjs
function trace(text) {
	return {
		text,
		offsets: Array.from({ length: text.length }, (_, i) => i)
	};
}
/** A non-empty range in a traced text, as a range in its original. */
function untrace({ offsets }, [start, end]) {
	return [offsets[start], offsets[end - 1] + 1];
}
/** `String.replace` with a global pattern, keeping track of offsets. */
function traceReplace({ text, offsets }, pattern, replacement) {
	let result = "";
	const resultOffsets = [];
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		result += text.slice(last, match.index) + replacement;
		resultOffsets.push(...offsets.slice(last, match.index), ...Array(replacement.length).fill(offsets[match.index]));
		last = match.index + match[0].length;
	}
	return {
		text: result + text.slice(last),
		offsets: [...resultOffsets, ...offsets.slice(last)]
	};
}
function trim({ text, offsets }) {
	const start = text.search(/\S|$/);
	const end = text.trimEnd().length;
	return {
		text: text.slice(start, Math.max(start, end)),
		offsets: offsets.slice(start, Math.max(start, end))
	};
}
/** Removes text the author didn't write: HTML comments and bot summaries. */
function traceAuthored(markdown) {
	return trim(traceReplace(traceReplace(markdown, /<!-- This is an auto-generated comment[\s\S]*?end of auto-generated comment[^>]*-->/g, ""), /<!--[\s\S]*?-->/g, ""));
}
/** Removes text the author didn't write: HTML comments and bot summaries. */
function authoredText(markdown) {
	return traceAuthored(trace(markdown)).text;
}
/** Normalizes a line for template matching, ignoring ticks, strike-through and list markers. */
function templateKey(line) {
	return line.replace(/~~/g, "").replace(/^\s*[-*+]\s+(?=\[[ xX]\])/, "").replace(/\[[ xX]\]/g, "[ ]").replace(/\s+/g, " ").trim().toLowerCase();
}
function unquote(value) {
	return value.replace(/^(["'])(.*)\1$/, "$2");
}
/**
* The lines a YAML issue form leaves in an issue: `### label` headings,
* checkbox and dropdown options, default values and `_No response_`.
*/
function issueFormLines(yaml) {
	const lines = ["_No response_"];
	const rows = yaml.split("\n");
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const field = row.match(/^(\s*)(-\s+)?(label|value):\s*(.*)$/);
		if (field) {
			const [, indent, option, key, value] = field;
			if (/^[|>][-+]?$/.test(value.trim())) while (i + 1 < rows.length && (rows[i + 1].trim() === "" || rows[i + 1].search(/\S/) > indent.length)) lines.push(rows[++i].trim());
			else if (key === "label") lines.push(option ? `- [ ] ${unquote(value.trim())}` : `### ${unquote(value.trim())}`);
			else lines.push(unquote(value.trim()));
			continue;
		}
		const dropdownOption = row.match(/^\s*-\s+(?![\w-]+:(?:\s|$))(.+)$/);
		if (dropdownOption) lines.push(unquote(dropdownOption[1].trim()));
	}
	return lines;
}
function isIssueForm(template) {
	return /^body:\s*$/m.test(template) && /^\s*-\s+type:/m.test(template);
}
/** The template lines, as keys to look a text's lines up by. */
function templateKeys(template) {
	return new Set((Array.isArray(template) ? template : [template]).flatMap((t) => isIssueForm(t) ? issueFormLines(t) : authoredText(t).split("\n")).map(templateKey).filter((line) => line.length > 2));
}
/** Removes lines copied from the PR or issue templates, ticked checklist items included. */
function traceWithoutTemplate({ text, offsets }, template) {
	const keys = templateKeys(template);
	const lines = [];
	let start = 0;
	for (const line of text.split("\n")) {
		if (!keys.has(templateKey(line))) lines.push({
			text: line,
			offsets: offsets.slice(start, start + line.length + 1)
		});
		start += line.length + 1;
	}
	return trim({
		text: lines.map((line) => line.text).join("\n"),
		offsets: lines.flatMap((line, i) => i < lines.length - 1 ? line.offsets : line.offsets.slice(0, line.text.length))
	});
}
/** Removes lines copied from the PR or issue templates, ticked checklist items included. */
function withoutTemplate(text, template) {
	return traceWithoutTemplate(trace(text), template).text;
}
/** Blanks out code blocks and inline code. Indented list items stay. */
function traceProse(text) {
	return traceReplace(traceReplace(traceReplace(text, /```[\s\S]*?```/g, ""), /^ {4,}(?![-*+] |\d+\. ).*$/gm, ""), /`[^`\n]*`/g, "X");
}
/** Blanks out code blocks and inline code. Indented list items stay. */
function prose(text) {
	return traceProse(trace(text)).text;
}
/** Minimum length for densities, so one code span in a short text isn't dense. */
const MIN_DENSITY_LENGTH = 300;
function counter(count, ranges) {
	return Object.assign(count, { ranges });
}
function matches(pattern) {
	const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
	const globalPattern = new RegExp(pattern.source, flags);
	return counter((text) => text.match(globalPattern)?.length ?? 0, (text) => Array.from(text.matchAll(globalPattern), (match) => [match.index, match.index + match[0].length]));
}
const CHECKLIST_ITEM = /^\s*[-*] \[[ xX]\].*$/gm;
/** Like `matches`, but skips checklist items (template wording, not the author's). */
function matchesOutsideChecklists(pattern) {
	const count = matches(pattern);
	return counter((text) => count(text.replace(CHECKLIST_ITEM, "")), (text) => {
		const traced = traceReplace(trace(text), CHECKLIST_ITEM, "");
		return count.ranges(traced.text).map((range) => untrace(traced, range));
	});
}
function isStatement(line) {
	return !/^\s*[-*] \[[ xX]\]/.test(line) && !/\?\s*(?:\*\*)?\s*$/.test(line) && !/:\s*(?:\*\*)?\s*(?:no|none|n\/a)\b/i.test(line);
}
/** Like `matchesOutsideChecklists`, but also skips questions and "no" answers. */
function matchesInStatements(pattern) {
	const count = matches(pattern);
	return counter((text) => text.split("\n").filter(isStatement).reduce((sum, line) => sum + count(line), 0), (text) => {
		const ranges = [];
		let offset = 0;
		for (const line of text.split("\n")) {
			if (isStatement(line)) for (const [start, end] of count.ranges(line)) ranges.push([offset + start, offset + end]);
			offset += line.length + 1;
		}
		return ranges;
	});
}
/** Matches per 1,000 characters. */
function density(pattern, count = matches(pattern)) {
	return counter((text) => {
		if (text.length === 0) return 0;
		return count(text) / Math.max(text.length, MIN_DENSITY_LENGTH) * 1e3;
	}, count.ranges);
}
/** Like `density`, but skips checklist items. */
function densityOutsideChecklists(pattern) {
	return density(pattern, matchesOutsideChecklists(pattern));
}
/** The trimmed prose lines of a text. */
function proseLines(text) {
	return prose(text).split("\n").map((line) => line.trim());
}
/** Each trimmed line of a text, with where it starts and ends. */
function lineSpans(text) {
	let offset = 0;
	return text.split("\n").map((line) => {
		const start = offset + line.search(/\S|$/);
		const trimmed = line.trim();
		offset += line.length + 1;
		return {
			line: trimmed,
			range: [start, start + trimmed.length]
		};
	});
}
/** The prose lines of a text that pass `test`, as ranges in the text. */
function proseLineRanges(text, test) {
	const traced = traceProse(trace(text));
	return lineSpans(traced.text).filter(({ line }) => test(line)).map(({ range }) => untrace(traced, range));
}
function isSentence(line) {
	return line.split(/\s+/).length >= 5 && !/^[-*#|>\d]/.test(line);
}
function isUnpunctuated(line) {
	return isSentence(line) && !/[.!?:)`]$/.test(line);
}
/** Prose lines of 5 or more words with no final punctuation. */
const unpunctuatedLines = counter((text) => proseLines(text).filter(isUnpunctuated).length, (text) => proseLineRanges(text, isUnpunctuated));
function isTidy(line) {
	return /^[A-Z`X]/.test(line) && /[.:)]$/.test(line);
}
/**
* Prose lines of 5 or more words, when every one of them starts with a capital
* and ends with punctuation. One untidy line, or fewer than two lines, counts 0.
*/
const tidyLines = counter((text) => {
	const lines = proseLines(text).filter(isSentence);
	return lines.every(isTidy) && lines.length >= 2 ? lines.length : 0;
}, (text) => {
	const ranges = proseLineRanges(text, isSentence);
	const lines = proseLines(text).filter(isSentence);
	return lines.every(isTidy) && lines.length >= 2 ? ranges : [];
});
function isLongParagraph(line) {
	return !/^(?:[-*#|>]|\d+\.)/.test(line) && line.split(/\s+/).length >= 50;
}
/** Prose paragraphs of 50 or more words. */
const longParagraphs = counter((text) => proseLines(text).filter(isLongParagraph).length, (text) => proseLineRanges(text, isLongParagraph));
const disclosureStatements = matchesInStatements(/\b(?:generated|authored|prepared|written|built|created|translated|drafted|produced|implemented)\b[^.\n]{0,30}\b(?:with|by|using|via)\b[^.\n]{0,25}\b(?:AI|LLM|Claude|Codex|Copilot|Cursor|ChatGPT|GPT-?\d|Gemini|an? (?:AI|coding) (?:assistant|agent))\b|\bAI[- ]assist(?:ed|ance)\b(?! development\b)|\bagent-assisted\b|\bwith (?:the help of )?an? AI\b|\bI used (?:Claude|Codex|Copilot|Cursor|ChatGPT|an AI)\b|\bused an AI assistant\b|\bAI[- ]generated (?:description|summary|PR|pull request|code|changes?|patch)\b|\bpair[- ]programmed with (?:an? )?(?:AI|Claude|Codex|Copilot|Cursor|ChatGPT)\b|\b(?:an? )?(?:AI|LLM)(?: agent| tool| assistant)? was used\b|\bhad (?:an? )?AI\b|^#{1,4}\s*AI (?:disclosure|usage|assistance)\b|^\s*(?:\*\*)?(?:Agent|Agent-Owner|AI tools? (?:and models )?used|AI (?:tool )?(?:use|usage)(?: disclosure)?|AI disclosure|Code assistance|Autonomy|Contribution source)(?:\*\*)?\s*:/im);
/** A ticked checklist item saying AI was used. Unticked ones are template text. */
const disclosureCheckboxes = matches(/^\s*[-*] \[[xX]\] I _?did_? use AI\b/im);
const soClauses = matches(/, so (?!that)\w+/i);
const SIGNALS = [
	{
		id: "agent-attribution",
		description: "names an AI agent or carries its attribution line",
		weight: 4,
		cap: 1,
		count: matches(/Generated with \[?Claude|Co-Authored-By: (?:Claude|Copilot|Codex)|Claude-Session:|claude\.ai\/code\/session|chatgpt\.com\/codex\/tasks|\b(?:Codex|Claude|Copilot|Cursor|Devin) (?:autoreview|review|agent)\b|\bautoreview\b|\bMade with \[?Cursor\b/i)
	},
	{
		id: "ai-disclosure",
		description: "discloses that an AI tool wrote or assisted the change",
		weight: 3,
		cap: 1,
		count: (text) => disclosureStatements(text) + disclosureCheckboxes(text),
		locate: (text) => [...disclosureStatements.ranges(text), ...disclosureCheckboxes.ranges(text)]
	},
	{
		id: "fails-before-fix",
		description: "claims tests were shown failing on the unfixed code",
		weight: 1.35,
		cap: 2,
		count: matches(/\b(?:fail|fails|failed|failing|red)\s+(?:on|against)\s+(?:the\s+)?(?:unfixed|unpatched|unmodified|old|original|prior|pinned|current)?\s*(?:`?main`?|`?master`?|`?dev`?|code|baseline|base|script|regex|file)\b|\bfail(?:s|ed|ing)?\b[^.\n]{0,40}\b(?:before|without) (?:the|this) (?:fix|change|patch)\b|\b(?:fail|fails|failed|times out)\b[^.\n]{0,60}\bwithout the \w+ (?:fix|change|patch)\b|\bwithout the fix\b|\bfails? before\b|\bpass(?:es)? after\b|\bpass(?:es|ed)? (?:after|with) (?:the|this) (?:fix|change|patch)\b|\bverified by reverting\b|\b(?:identically )?on (?:unmodified|unfixed|unpatched) `?(?:main|dev)`?|\ball red on\b|\bfresh-base-red\b/i)
	},
	{
		id: "git-diff-check",
		description: "reports running `git diff --check`",
		weight: 1.01,
		cap: 1,
		count: matches(/git diff --check/)
	},
	{
		id: "lint-clean",
		description: "reports a linter or type check as clean",
		weight: .41,
		cap: 2,
		count: matches(/\b(?:ruff check|tsgo|tsc --noEmit|oxlint|oxfmt|biome check|eslint)\b[^\n]{0,80}?\b(?:clean|pass(?:es|ed)?)\b|All checks passed!/i)
	},
	{
		id: "review-severity",
		description: "uses P0/P1/P2 review-severity wording",
		weight: 2,
		cap: 1,
		count: matches(/\b(?:clean|findings?) (?:through|at) P[0-3]\b|\bat P[0-3](?:\/P[0-3])?\b|\bscoped-clean\b/)
	},
	{
		id: "epistemic-hedge",
		description: "pre-empts over-reading its own evidence (\"X, not Y\")",
		weight: .65,
		cap: 2,
		count: matches(/\bnot (?:a |an )?(?:controlled|claimed|unmodified)\b|\b(?:no|not) (?:root cause|fix) (?:or fix )?is claimed\b|\bevidence, not a\b|\bnot a claim\b|\brather than a (?:harness error|fragile workaround)\b|\bfail for the reported reason\b|\b(?:was|were) not run\b|\bnot run locally\b|\bdid not run\b/i)
	},
	{
		id: "maintainer-deference",
		description: "defers decisions to a maintainer",
		weight: .87,
		cap: 2,
		count: matches(/\bfor a maintainer\b|\bsay the word\b|\bmaintainer[- ]requested\b|\bmaintainer'?s? (?:explicit|work order|decision)\b|\bif you would rather\b|\bjudgement call worth surfacing\b/i)
	},
	{
		id: "plan-reference",
		description: "points to a plan file or the commit message for detail",
		weight: .21,
		cap: 2,
		count: matches(/\b(?:SPEC|BUILD_PLAN|PLAN|TODO|CHANGES)\.md\b|\bsee (?:the )?commit message\b|\bfull (?:design rationale|details)\b/i)
	},
	{
		id: "live-verification",
		description: "describes a live or end-to-end proof run",
		weight: 1.2,
		cap: 1,
		count: matches(/\blive end-to-end\b|\bconfirmed directly\b|\blive (?:run|registry|proof|CLI proof)\b|\bdry run against\b|\b(?:existing|full unit) suite\b[^\n]{0,40}\b(?:green|passed)\b/i)
	},
	{
		id: "stacked-pr",
		description: "says it is stacked on or supersedes another PR",
		weight: .63,
		cap: 1,
		count: matches(/\bstacked on #\d+|\bsupersedes #\d+/i)
	},
	{
		id: "commit-shas",
		description: "cites commit SHAs, CI run or job IDs",
		weight: -.62,
		cap: 4,
		count: matches(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,40}\b|\b(?:run|job) `?\d{9,}\b/)
	},
	{
		id: "validation-line",
		description: "has a Validation: or Tested: line with test commands",
		weight: 2,
		cap: 1,
		count: matches(/(?:Validation|Tested|Verified|Tests?):\s*(?:go test|test |bun bd test|npm test|yarn test|pnpm test|make test|\w+ test)/i)
	},
	{
		id: "verification-label",
		description: "opens a line with a Validation:, Root cause: or Fix: label",
		weight: .74,
		cap: 2,
		count: matches(/^(?:\*\*)?(?:Validation|Verification|Local checks|How I (?:checked|verified|tested)|How verified|Test plan|Testing|Tests?|Tested|Root cause|Fix|Benchmarks?)(?:\*\*)?(?: \([^)\n]*\))?(?:\*\*)?:(?:\s*$|(?:\s+\S+){8})/m)
	},
	{
		id: "test-reference",
		description: "mentions tests or regression tests",
		weight: 1.46,
		cap: 3,
		count: matches(/\bregression (?:tests?|coverage)\b|\btest case\b|\brun test\b|\bunit test\b|\btests? cover\b|\bregressions cover\b|\bcoverage for\b|\bcovers? (?:both|the|every)\b/i)
	},
	{
		id: "semicolons",
		description: "joins clauses with semicolons",
		weight: 3.7,
		cap: 5,
		prose: true,
		count: density(/; /)
	},
	{
		id: "code-span-density",
		description: "wraps many names in inline `code` spans",
		weight: 1.28,
		cap: 15,
		count: densityOutsideChecklists(/`[^`\n]+`/)
	},
	{
		id: "bold-lead-bullets",
		description: "starts bullets or paragraphs with a **bold lead**",
		weight: 4,
		cap: 12,
		count: matches(/^\s*(?:[-*]|\d+\.) \*\*[^*\n]+\*\*|^\*\*[^*\n]{2,60}\*\*[:.]? \S/m)
	},
	{
		id: "em-dash",
		description: "uses em-dashes heavily",
		weight: 4,
		cap: 4,
		prose: true,
		count: density(/—/)
	},
	{
		id: "template-headings",
		description: "uses the headings agent PR templates favour",
		weight: 2.37,
		cap: 2,
		count: matches(/^#{1,4}\s*(?:Summary|Overview|TL;?DR|Verification|Validation|How (?:it was|this was|I) tested|Testing|Test plan|Tests|Evidence|Checks)\s*$/im)
	},
	{
		id: "colon-bullets",
		description: "shapes bullets as `- label: explanation`",
		weight: 1.45,
		cap: 8,
		prose: true,
		count: matches(/^\s*[-*] [^:\n]{2,40}: \S/m)
	},
	{
		id: "arrows",
		description: "uses → or -> in prose",
		weight: 2.05,
		cap: 8,
		prose: true,
		count: matches(/→| -> /)
	},
	{
		id: "file-paths",
		description: "names source files by path",
		weight: .14,
		cap: 5,
		count: matches(/\b[\w.-]+\/[\w./-]+\.(?:ts|tsx|js|py|rs|go|java|cs|rb|md|json|yml|yaml|toml|swift|kt|cpp|h|c)\b/)
	},
	{
		id: "scope-disclaimer",
		description: "lists what the change deliberately did not touch",
		weight: 2.19,
		cap: 3,
		prose: true,
		count: matches(/^#{1,4}\s*(?:out of scope|not in (?:this|scope)|non-goals|known limitations)\b|\b(?:are|is|remains?|stays?) (?:unaffected|unchanged|untouched)\b|\bno (?:behaviou?r|functional|user-visible|api) changes?\b|\bnothing else (?:is )?(?:touched|changed)\b|\bno (?:other|unrelated) (?:changes|files|tool)\b|\bout of scope\b|\bnot in scope\b|\bintentionally (?:not|left|kept)\b|\bdeliberately\b|\bunrelated to this change\b|\b(?:nothing|no) (?:[\w-]+ ){0,3}changes\b|\bstays? the same\b|\bas before\b|\bleft (?:unchanged|untouched)\b|\bkeeps? (?:its|their) existing\b/im)
	},
	{
		id: "test-tally",
		description: "quotes exact pass/skip/fail counts",
		weight: 1.92,
		cap: 3,
		count: matches(/\b\d[\d,]*\s*(?:tests?\s+)?(?:passed|pass(?:ing)?)\b(?:,\s*\d[\d,]*\s+(?:skipped|failed|xfailed))*|\b\d+\/\d+\s+(?:pass|passed|cases|tests)\b|\ball \d+ (?:[\w`.-]+ ){0,3}tests?\b|\b\d+ (?:[\w`.-]+ ){0,3}tests? (?:now )?pass(?:es|ed)?\b/i)
	},
	{
		id: "agent-vocabulary",
		description: "uses words agents overuse (idempotent, surfaces, invariant…)",
		weight: 2.77,
		cap: 4,
		prose: true,
		count: matches(/\bload-bearing\b|\bcanonical (?:owner|\w+ normalizer)\b|\b(?:existing|durable|single|shared|leaf) owner\b|\bcustody\b|\bfenc(?:e|ed|ing)\b|\binvariants?\b|\bbyte-for-byte\b|\bbyte-identical\b|\bregression controls?\b|\bpin (?:the|a) bug\b|\bidempotent\b|\bdeterministic(?:ally)?\b|\bsurfaced?\b|\bsurfaces\b|\bguards? against\b|\bverbatim\b|\bleverag(?:e|es|ing)\b|\bseamless(?:ly)?\b|\bsilently\b/i)
	},
	{
		id: "long-paragraphs",
		description: "explains in long unbroken paragraphs",
		weight: .38,
		cap: 2,
		count: longParagraphs
	},
	{
		id: "so-chains",
		description: "chains consequences with \", so\" more than once",
		weight: 2.77,
		cap: 3,
		prose: true,
		count: (text) => Math.max(0, soClauses(text) - 1),
		locate: soClauses.ranges
	},
	{
		id: "existing-precedent",
		description: "justifies the change by code that already does the same",
		weight: 1.06,
		cap: 2,
		prose: true,
		count: matches(/\balready (?:uses|does|has|had|takes|handles|covers|sends|emits|exists?)\b|\bthe same (?:\w+ ){1,4}(?:already|as)\b/i)
	},
	{
		id: "now-verbs",
		description: "states what the code \"now does\" after the change",
		weight: 2.54,
		cap: 3,
		prose: true,
		count: matches(/\bnow \w+(?:s|ed)\b/i)
	},
	{
		id: "tables",
		description: "lays information out in markdown tables",
		weight: .41,
		cap: 20,
		count: matches(/^\|.*\|\s*$/m)
	},
	{
		id: "tidy-prose",
		description: "writes every sentence capitalized and punctuated",
		weight: .32,
		cap: 4,
		count: tidyLines
	},
	{
		id: "existing-reference",
		description: "points at \"the existing\" code it builds on",
		weight: 2.72,
		cap: 3,
		prose: true,
		count: matches(/\bthe existing\b/i)
	},
	{
		id: "unchanged-claims",
		description: "says what stays unchanged or unaffected",
		weight: 1.92,
		cap: 2,
		prose: true,
		count: matches(/\bunchanged\b|\bunaffected\b/i)
	},
	{
		id: "which-clauses",
		description: "explains through \", which does…\" clauses",
		weight: .95,
		cap: 3,
		prose: true,
		count: matches(/, which \w+s\b/i)
	},
	{
		id: "contrast-phrases",
		description: "contrasts with \"rather than\" or \"instead of\"",
		weight: .99,
		cap: 3,
		prose: true,
		count: matches(/\b(?:rather than|instead of)\b/i)
	},
	{
		id: "imperative-sentences",
		description: "gives the change as imperative sentences mid-paragraph",
		weight: 1.63,
		cap: 3,
		prose: true,
		count: matches(/[.:] (?:Add|Remove|Use|Preserve|Keep|Update|Replace|Return|Reject|Skip|Make|Move|Pass|Clear|Show|Match|Mark|Restore|Retain|Expire|Give|Check|Raise|Wrap|Select|Treat|Record|Validate|Extend|Allow|Prevent|Avoid|Drop|Ignore|Honor|Load|Emit|Render|Set|Document|Regenerate|Guard|Handle|Normalize|Resolve|Reuse|Apply|Cover|Stop|Start|Expose|Accept|Require) (?:the|a|an|each|every|all|both|this|that|its|their|X|[a-z]+s)\b/)
	},
	{
		id: "plan-headings",
		description: "plans in headings like Acceptance Criteria, Scope or Next Steps",
		weight: 4,
		cap: 3,
		count: matches(/^#{1,4}\s*(?:\p{Extended_Pictographic}\uFE0F?\s*)?(?:Acceptance Criteria|Definition of Done|Success Criteria|Priority|Scope|Dependencies|Requirements|Impact|Implementation(?: Notes| Plan| Details)?|Tasks|Problem(?: Statement)?|Related(?: Issues| PRs| Work)?|Context|Technical (?:Details|Notes)|Next Steps|Root Cause|(?:Proposed )?Fix|Changes Made|Files (?:Changed|Modified))\s*:?\s*$/imu)
	},
	{
		id: "emoji-markers",
		description: "marks headings, bullets or lines with emoji (✅ 🎯 📋)",
		weight: 1.01,
		cap: 4,
		prose: true,
		count: matches(/^\s*(?:#{1,6}\s*|[-*+]\s+|\d+\.\s+)?(?:\*\*)?\p{Extended_Pictographic}/mu)
	},
	{
		id: "status-openers",
		description: "opens a paragraph with a bare status verb (\"Rebased onto…\", \"Addressed in…\")",
		weight: 3.03,
		cap: 2,
		prose: true,
		count: matches(/^(?:Rebased|Dropped|Verified|Investigated|Pushed|Addressed|Reworked|Restored|Confirmed|Re-?ran|Kept|Tightened|Narrowed|Folded|Landed|Withdrawing|Superseded by|Closing (?:this|as|in favou?r|for now))\b/m)
	},
	{
		id: "review-pleasantries",
		description: "answers review with stock courtesies (\"You're right\", \"Good catch\", \"gentle ping\")",
		weight: 2.94,
		cap: 2,
		prose: true,
		count: matches(/\byou['’]re (?:absolutely )?(?:right|correct)\b|\b(?:good|great|nice) catch\b|\bfair (?:point|question)\b|\bthanks? (?:you )?for (?:the |your )?(?:review|feedback|clarification|follow-up|pointer|heads[- ]up|careful|thorough|detailed|quick|precise|thoughtful|taking the time)\b|\bappreciate (?:the|you|your)\b|\b(?:gentle|friendly) (?:ping|nudge|bump|reminder)\b|\bwhen(?:ever)? you (?:have|get) a (?:moment|chance)\b/i)
	},
	{
		id: "happy-to",
		description: "offers to do more (\"happy to adjust\")",
		weight: 2.58,
		cap: 2,
		prose: true,
		count: matches(/\bhappy to\b/i)
	},
	{
		id: "maintainer-mention",
		description: "writes to or about \"the maintainers\"",
		weight: 1.61,
		cap: 2,
		prose: true,
		count: matches(/\bmaintainers?\b/i)
	},
	{
		id: "work-claim",
		description: "claims the issue (\"I can take this\", \"/claim #12\")",
		weight: 1.88,
		cap: 1,
		prose: true,
		count: matches(/\bI can take (?:this|a look|it)\b|\bI['’]d like to (?:take|work on|pick up|tackle) (?:this|it)\b|\bI['’]ll take (?:this|it)(?: on)?\b|\bI['’]m picking this up\b|\bclaiming\b|\/(?:claim|attempt) #?\d+/i)
	},
	{
		id: "workflow-vocabulary",
		description: "uses contribution jargon (\"follow-up\", \"rebased onto\", \"focused PR\", \"regression test\")",
		weight: 3.1,
		cap: 3,
		prose: true,
		count: matches(/\bfollow-up\b|\brebased (?:on|onto)\b|\b(?:small|minimal|narrow|focused|scoped)(?:,? (?:scoped|focused))? (?:PR|fix|change|patch)\b|\bkeep (?:it|this|the (?:fix|change|PR)) (?:scoped|focused|minimal|narrow|small)\b|\bregression (?:test|coverage)\b/i)
	},
	{
		id: "ci-green",
		description: "reports CI or checks as green",
		weight: 1.95,
		cap: 2,
		prose: true,
		count: matches(/\b(?:CI|checks?|tests?|suite|jobs?|builds?|legs?)\b[^.\n]{0,25}?\b(?:green|passing)\b|\ball (?:\d+ )?(?:checks|jobs) (?:pass|are green)\b/i)
	},
	{
		id: "evidence-claims",
		description: "weighs what is \"established\", \"demonstrated\" or \"claimed\"",
		weight: 1.41,
		cap: 3,
		prose: true,
		count: matches(/\bclaimed\b|\b(?:is|are|was|were|been|isn['’]t|aren['’]t|not) (?:yet )?established\b|\bestablish(?:es|ed)? (?:that|whether|an? (?:real|genuine|concrete|exploitable))\b|\bdemonstrat(?:e|es|ed|ing)\b|\bconcrete\b|\bsubstantiat\w+|\boverstat\w+/i)
	},
	{
		id: "not-contrast",
		description: "corrects itself in passing (\", not a race\")",
		weight: 2.25,
		cap: 3,
		prose: true,
		count: matches(/, not (?!sure\b|yet\b|really\b|quite\b|that\b|exactly\b|to\b|so\b|much\b|necessarily\b|even\b|at all\b)(?:a |an |the |just |only )?\w+/)
	},
	{
		id: "math-symbols",
		description: "uses typeset symbols (≥ × ≈) in prose",
		weight: 1.37,
		cap: 3,
		prose: true,
		count: matches(/[≥≤×≈⇒≠]/)
	},
	{
		id: "shell-escapes",
		description: "has stray shell escapes (`\\!`, literal `\\n`) from posting via a CLI",
		weight: 1.98,
		cap: 1,
		prose: true,
		count: matches(/\\[!`]|\\n\\n/)
	},
	{
		id: "first-person",
		description: "writes in the first person (I, my, me)",
		weight: -.94,
		cap: 7,
		prose: true,
		count: densityOutsideChecklists(/\b(?:I|I'm|I've|I'd|I'll|my|me)\b/)
	},
	{
		id: "screenshots",
		description: "attaches screenshots or images",
		weight: -1.28,
		cap: 8,
		count: matches(/!\[[^\]]*\]\(|<img\s|user-images\.githubusercontent|github\.com\/user-attachments/i)
	},
	{
		id: "this-pr",
		description: "refers to the change as \"this PR\"",
		weight: -.81,
		cap: 3,
		prose: true,
		count: matches(/\bthis (?:PR|pull request)\b/i)
	},
	{
		id: "contractions",
		description: "uses contractions (don't, it's, we'll)",
		weight: -1.15,
		cap: 6,
		prose: true,
		count: density(/\b\w+(?:n't|'re|'ll|'ve|'d)\b|\b(?:it's|that's|there's|let's|what's)\b/i)
	},
	{
		id: "template-checkboxes",
		description: "has a checkbox list",
		weight: -.87,
		cap: 8,
		count: matches(/^\s*[-*] \[[ x]\]/im)
	},
	{
		id: "unpunctuated-lines",
		description: "leaves sentences without final punctuation",
		weight: -1.47,
		cap: 5,
		count: unpunctuatedLines
	},
	{
		id: "bare-urls",
		description: "pastes bare URLs instead of markdown links",
		weight: -1.23,
		cap: 4,
		prose: true,
		count: matches(/(?<![(<])https?:\/\/\S+/)
	},
	{
		id: "questions",
		description: "asks the reviewer questions",
		weight: -2.27,
		cap: 4,
		prose: true,
		count: matches(/\?(?:\s|$)/m)
	},
	{
		id: "tentative",
		description: "is tentative or informal (\"not sure\", \"WIP\", \"let me know\")",
		weight: -2.97,
		cap: 3,
		prose: true,
		count: matches(/\b(?:WIP|not sure|I think|I guess|maybe|probably|let me know|feel free)\b/i)
	},
	{
		id: "emoticons",
		description: "uses emoticons or emoji shortcodes (\":)\", \"lol\", \":tada:\")",
		weight: -2.05,
		cap: 2,
		prose: true,
		count: matches(/(?:^|\s)(?::\)|:-\)|:D|;\)|:\(|:P|xD)(?=\s|$|[.,!])|\blol\b|\bhaha\w*\b|\bhehe\b|:[a-z_+-]+:/im)
	},
	{
		id: "gratitude",
		description: "thanks someone (\"thanks\", \"thank you\", \"cheers\")",
		weight: 0,
		cap: 2,
		prose: true,
		count: matches(/\b(?:thanks|thank you|thx|cheers)\b/i)
	},
	{
		id: "short-body",
		description: "is too short to carry agent structure",
		weight: -1.44,
		cap: 1,
		count: (text) => text.length < 150 ? 1 : 0
	}
];
/** Runs every signal on a text, before weighting. Used by `analyzeText` and the weight fit. */
function measure(markdown, template, signals = SIGNALS) {
	const authored = authoredText(markdown ?? "");
	const text = template ? withoutTemplate(authored, template) : authored;
	const proseText = prose(text);
	const measurements = [];
	for (const signal of signals) {
		const hits = signal.count(signal.prose ? proseText : text);
		if (hits > 0) measurements.push({
			signal,
			hits,
			strength: Math.min(hits, signal.cap) / signal.cap
		});
	}
	return measurements;
}
function round(n, digits = 2) {
	const factor = 10 ** digits;
	return Math.round(n * factor) / factor;
}
function sigmoid(x) {
	return 1 / (1 + Math.exp(-x));
}
/**
* Starting log-odds. Set so at most about 3% of pre-agent PRs, issues or
* comments score as AI, because a false accusation is worse than a miss.
*/
const BIAS = -1.38;
/**
* The model's score, 0 to 100 with 100 human, and the signals behind it.
* `analyzeText` builds its result on this. The regression tests measure it
* directly, so a text with too little to score still has a number to compare.
*/
function scoreText(markdown, template) {
	let logit = BIAS;
	const signals = [];
	const active = SIGNALS.filter((signal) => signal.weight !== 0);
	for (const { signal, hits, strength } of measure(markdown, template, active)) {
		const contribution = signal.weight * strength;
		logit += contribution;
		signals.push({
			id: signal.id,
			description: signal.description,
			hits: round(hits),
			contribution: round(contribution)
		});
	}
	signals.sort((a, b) => b.contribution - a.contribution);
	return {
		score: round(100 * (1 - sigmoid(logit)), 1),
		signals
	};
}
/**
* Guesses whether a text, like a PR description, issue or comment, was written
* by an AI agent. Every text is read the same way.
*
* Pass the repo's PR or issue template if you have it, so its headings and
* checklists don't count against the author.
*
* @example
* const { verdict, confidence } = analyzeText(pr.body ?? "", { template });
* const { verdict } = analyzeText(comment.body);
*/
function analyzeText(markdown, options = {}) {
	const { score, signals } = scoreText(markdown, options.template);
	if (signals.every((signal) => signal.id === "short-body")) return {
		verdict: "human",
		classification: "insufficient-data",
		score: -1,
		confidence: .5,
		signals
	};
	const verdict = score < 50 ? "ai" : "human";
	return {
		verdict,
		classification: classify(score),
		score,
		confidence: round((verdict === "ai" ? 100 - score : score) / 100, 3),
		signals
	};
}
function classify(score) {
	if (score < 50) return "automation";
	if (score < 70) return "mixed";
	return "organic";
}
//#endregion
//#region src/analysis/marker.ts
const START_MARKER = "<!-- interlinked:start -->";
const END_MARKER = "<!-- interlinked:end -->";
const ANALYSIS_BLOCK_PATTERN = new RegExp(`\\n*${START_MARKER}[\\s\\S]*?${END_MARKER}\\n*`, "g");
/** Removes a previous run's analysis so it never counts toward the score. */
function stripAnalysisBlock(body) {
	return body.replace(ANALYSIS_BLOCK_PATTERN, "\n").trimEnd();
}
function hasAnalysisBlock(body) {
	return body.includes(START_MARKER);
}
function appendAnalysisBlock(description, analysis) {
	return `${description}\n\n${START_MARKER}\n---\n\n${analysis}\n${END_MARKER}\n`;
}
function wrapAnalysisComment(analysis) {
	return `${START_MARKER}\n${analysis}\n${END_MARKER}`;
}
function isAnalysisComment(body) {
	return body.startsWith(START_MARKER);
}
//#endregion
//#region src/analysis/render.ts
const ICONS_BASE_URL = "https://raw.githubusercontent.com/MatteoGabriele/agentscan-text-action/main/icons";
/** Worded like agentscan's account classifications, for text. */
const CLASSIFICATION_DETAILS = {
	organic: {
		icon: "heart-handshake",
		label: "Organic writing",
		description: "Reads like a person wrote it."
	},
	mixed: {
		icon: "shield-question-mark",
		label: "Mixed writing",
		description: "Reads partly like a person and partly like an agent wrote it."
	},
	automation: {
		icon: "shield-alert",
		label: "Agent-style writing",
		description: "Reads like an agent wrote it."
	},
	"insufficient-data": {
		icon: "circle-dashed",
		label: "Insufficient data",
		description: "Not enough text to make a reliable assessment."
	}
};
function renderIcon(name) {
	return `<picture><img src="${ICONS_BASE_URL}/${name}.svg" width="16" height="16" alt=""></picture>`;
}
function renderHeading(result) {
	const details = CLASSIFICATION_DETAILS[result.classification];
	const heading = `${renderIcon(details.icon)} **${details.label}**`;
	if (result.classification === "insufficient-data") return heading;
	return `${heading} · score ${Math.round(result.score)}/100`;
}
function formatContribution(contribution) {
	return `${contribution > 0 ? "+" : ""}${contribution}`;
}
function renderSignalsTable(signals) {
	return [
		"<details><summary>Signals</summary>",
		"",
		"| Signal | Hits | Contribution |",
		"| --- | --- | --- |",
		...signals.map((signal) => `| ${signal.description} | ${signal.hits} | ${formatContribution(signal.contribution)} |`),
		"",
		"</details>"
	].join("\n");
}
/** A custom message replaces the classification's description, as in agentscan. */
function renderAnalysis(result, customMessage = "") {
	const sections = [renderHeading(result), customMessage || CLASSIFICATION_DETAILS[result.classification].description];
	if (result.signals.length > 0) sections.push(renderSignalsTable(result.signals));
	return sections.join("\n\n");
}
//#endregion
//#region src/utils/inputs.ts
/** `fallback` applies only when the input isn't set at all, so an explicit empty value still wins. */
function readInput(name, fallback = "") {
	const envName = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
	return (process.env[envName] ?? fallback).trim();
}
function readBooleanInput(name) {
	return readInput(name) === "true";
}
/** Accepts a JSON array or a comma-separated string. */
function readListInput(name, fallback = "") {
	const rawValue = readInput(name, fallback);
	if (!rawValue) return [];
	return parseList(rawValue).map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}
function parseList(rawValue) {
	try {
		const parsed = JSON.parse(rawValue);
		return Array.isArray(parsed) ? parsed : rawValue.split(",");
	} catch {
		return rawValue.split(",");
	}
}
//#endregion
//#region src/utils/workflow.ts
function logWarning(message) {
	console.log(`::warning::${message}`);
}
function logError(message) {
	console.log(`::error::${message}`);
}
function setOutput(name, value) {
	const outputFile = process.env.GITHUB_OUTPUT;
	if (!outputFile) return;
	const delimiter = `interlinked_${Math.random().toString(36).slice(2)}`;
	appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
function appendJobSummary(markdown) {
	const summaryFile = process.env.GITHUB_STEP_SUMMARY;
	if (summaryFile) appendFileSync(summaryFile, `${markdown}\n`);
}
//#endregion
//#region src/config.ts
const MODES = [
	"full",
	"labels",
	"description",
	"silent"
];
const ANALYSIS_LOCATIONS = ["description", "comment"];
/** The classifications worth acting on, as in agentscan. */
const FLAGGED_CLASSIFICATIONS = ["mixed", "automation"];
const KNOWN_AUTHOR_ASSOCIATIONS = [
	"collaborator",
	"contributor",
	"first_timer",
	"first_time_contributor",
	"member",
	"owner"
];
const DEFAULT_MODE = "labels";
const DEFAULT_ANALYSIS_LOCATION = "comment";
const DEFAULT_TRUSTED_AUTHOR_ASSOCIATIONS = "member,owner";
const DEFAULT_AUTO_CLOSE_CLASSIFICATIONS = "automation";
/** Prefixed like agentscan's account labels, but distinct so both actions can run together. */
const DEFAULT_LABELS = {
	mixed: "agentscan:mixed-text",
	automation: "agentscan:automated-text"
};
function readConfig() {
	return {
		mode: readChoice("mode", MODES, DEFAULT_MODE),
		analysisLocation: readChoice("analysis-location", ANALYSIS_LOCATIONS, DEFAULT_ANALYSIS_LOCATION),
		allowedUsers: readListInput("allowed-users"),
		trustedAuthorAssociations: readListInput("trusted-author-associations", DEFAULT_TRUSTED_AUTHOR_ASSOCIATIONS).filter((association) => KNOWN_AUTHOR_ASSOCIATIONS.includes(association)),
		shouldCommentOnOrganic: readBooleanInput("comment-on-organic"),
		labels: {
			mixed: readInput("label-mixed") || DEFAULT_LABELS.mixed,
			automation: readInput("label-automation") || DEFAULT_LABELS.automation
		},
		messages: {
			organic: readInput("message-organic"),
			mixed: readInput("message-mixed"),
			automation: readInput("message-automation")
		},
		shouldAutoClose: readBooleanInput("auto-close"),
		autoCloseClassifications: readClassifications("auto-close-classifications", DEFAULT_AUTO_CLOSE_CLASSIFICATIONS),
		failOnClassifications: readClassifications("fail-on-classifications")
	};
}
function readChoice(name, choices, fallback) {
	const requested = readInput(name).toLowerCase() || fallback;
	if (choices.includes(requested)) return requested;
	logWarning(`Invalid ${name} "${requested}", falling back to "${fallback}".`);
	return fallback;
}
function readClassifications(name, fallback = "") {
	return readListInput(name, fallback).filter((item) => {
		if (isFlaggedClassification(item)) return true;
		logWarning(`Ignoring unknown classification "${item}" in ${name}.`);
		return false;
	});
}
function isFlaggedClassification(classification) {
	return FLAGGED_CLASSIFICATIONS.includes(classification);
}
function shouldPublishAnalysis(mode) {
	return mode === "full" || mode === "description";
}
function shouldSyncLabel(mode) {
	return mode === "full" || mode === "labels";
}
//#endregion
//#region src/utils/github-api.ts
function githubRequest(path, init = {}) {
	const baseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
	const token = readInput("github-token");
	return fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...token ? { Authorization: `Bearer ${token}` } : {},
			...init.headers
		}
	});
}
async function warnOnFailedResponse(response, failureMessage) {
	if (response.ok) return;
	logWarning(`${failureMessage}: ${response.status} ${await response.text()}`);
}
//#endregion
//#region src/github/comments.ts
/** Only bot comments count, so a commenter can't plant one for us to overwrite. */
async function findAnalysisComment(repo, pullNumber) {
	const response = await githubRequest(`/repos/${repo}/issues/${pullNumber}/comments?per_page=100`);
	if (!response.ok) return;
	return (await response.json()).find((comment) => {
		return comment.user?.type === "Bot" && isAnalysisComment(comment.body ?? "");
	});
}
/**
* Edits the previous run's comment in place instead of posting a new one each
* run. With `createIfMissing` off, it only ever edits.
*/
async function upsertAnalysisComment(repo, pullNumber, body, { createIfMissing = true } = {}) {
	const existing = await findAnalysisComment(repo, pullNumber);
	if (!existing && !createIfMissing) return;
	let response;
	if (existing) response = await githubRequest(`/repos/${repo}/issues/comments/${existing.id}`, {
		method: "PATCH",
		body: JSON.stringify({ body })
	});
	else response = await githubRequest(`/repos/${repo}/issues/${pullNumber}/comments`, {
		method: "POST",
		body: JSON.stringify({ body })
	});
	await warnOnFailedResponse(response, "Couldn't post the analysis comment");
}
//#endregion
//#region src/github/labels.ts
async function addLabel(repo, pullNumber, label) {
	await warnOnFailedResponse(await githubRequest(`/repos/${repo}/issues/${pullNumber}/labels`, {
		method: "POST",
		body: JSON.stringify({ labels: [label] })
	}), `Couldn't add label "${label}"`);
}
//#endregion
//#region src/github/pull-request.ts
function patchPullRequest(repo, pullNumber, changes) {
	return githubRequest(`/repos/${repo}/pulls/${pullNumber}`, {
		method: "PATCH",
		body: JSON.stringify(changes)
	});
}
async function updatePullRequestBody(repo, pullNumber, body) {
	await warnOnFailedResponse(await patchPullRequest(repo, pullNumber, { body }), "Couldn't update the PR description");
}
async function closePullRequest(repo, pullNumber) {
	await warnOnFailedResponse(await patchPullRequest(repo, pullNumber, { state: "closed" }), "Couldn't close the PR");
}
//#endregion
//#region src/github/template.ts
const TEMPLATE_LOOKUP_PATHS = [
	".github/pull_request_template.md",
	".github/PULL_REQUEST_TEMPLATE.md",
	"pull_request_template.md",
	"PULL_REQUEST_TEMPLATE.md",
	"docs/pull_request_template.md",
	"docs/PULL_REQUEST_TEMPLATE.md"
];
async function fetchPullRequestTemplate(repo, ref) {
	for (const templatePath of TEMPLATE_LOOKUP_PATHS) {
		const response = await githubRequest(`/repos/${repo}/contents/${templatePath}?ref=${ref}`, { headers: { Accept: "application/vnd.github.raw+json" } });
		if (response.ok) return response.text();
	}
}
//#endregion
//#region src/run.ts
function readPullRequestEvent() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is not set. Is this running in Actions?");
	return JSON.parse(readFileSync(eventPath, "utf8"));
}
function findSkipReason(pull, config) {
	const author = pull.user.login;
	if (config.allowedUsers.includes(author.toLowerCase())) return `Skipping analysis for ${author}`;
	const association = pull.author_association?.toLowerCase();
	if (association && config.trustedAuthorAssociations.includes(association)) return `Skipping analysis for ${author} (trusted author association: ${association})`;
}
async function fetchTemplateSafely(repo, ref) {
	try {
		return await fetchPullRequestTemplate(repo, ref);
	} catch (error) {
		logWarning(`Couldn't fetch the PR template, analyzing without it: ${error.message}`);
		return;
	}
}
function publishOutputs(result) {
	setOutput("classification", result.classification);
	setOutput("score", String(result.score));
	setOutput("confidence", String(result.confidence));
	setOutput("signals", JSON.stringify(result.signals));
}
function warnOnError(error) {
	logWarning(error.message);
}
/**
* With `createIfMissing` off, only a previous run's analysis is brought up to
* date, so an edit that clears a flag doesn't leave the old verdict behind.
*/
async function publishAnalysis(pull, repo, description, analysis, config, createIfMissing) {
	if (config.analysisLocation === "comment") {
		await upsertAnalysisComment(repo, pull.number, wrapAnalysisComment(analysis), { createIfMissing });
		return;
	}
	if (!createIfMissing && !hasAnalysisBlock(pull.body ?? "")) return;
	const updatedBody = appendAnalysisBlock(description, analysis);
	if (updatedBody !== pull.body) await updatePullRequestBody(repo, pull.number, updatedBody);
}
async function run() {
	const event = readPullRequestEvent();
	const pull = event.pull_request;
	if (!pull) {
		logWarning("No pull request in this event. Run on pull_request or pull_request_target.");
		return;
	}
	const config = readConfig();
	const skipReason = findSkipReason(pull, config);
	if (skipReason) {
		console.log(skipReason);
		return;
	}
	const repo = event.repository.full_name;
	const template = await fetchTemplateSafely(repo, pull.base.sha);
	const description = stripAnalysisBlock(pull.body ?? "");
	const result = analyzeText(description, { template });
	const { classification } = result;
	const isFlagged = isFlaggedClassification(classification);
	console.log(`#${pull.number}: ${classification} (score ${result.score})`);
	publishOutputs(result);
	const analysis = renderAnalysis(result, config.messages[classification]);
	appendJobSummary(analysis);
	if (shouldPublishAnalysis(config.mode)) await publishAnalysis(pull, repo, description, analysis, config, isFlagged || config.shouldCommentOnOrganic).catch(warnOnError);
	if (!isFlagged) return;
	if (shouldSyncLabel(config.mode)) await addLabel(repo, pull.number, config.labels[classification]).catch(warnOnError);
	if (config.shouldAutoClose && config.autoCloseClassifications.includes(classification)) await closePullRequest(repo, pull.number).catch(warnOnError);
	if (config.failOnClassifications.includes(classification)) {
		logError(`The PR description is classified as ${classification}.`);
		process.exitCode = 1;
	}
}
//#endregion
//#region src/index.ts
run().catch((error) => {
	logError(error.message);
	process.exitCode = 1;
});
//#endregion
export {};
