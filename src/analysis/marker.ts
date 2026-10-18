const START_MARKER = "<!-- interlinked:start -->";
const END_MARKER = "<!-- interlinked:end -->";
const ANALYSIS_BLOCK_PATTERN = new RegExp(
	`\\n*${START_MARKER}[\\s\\S]*?${END_MARKER}\\n*`,
	"g",
);

/** Removes a previous run's analysis so it never counts toward the score. */
export function stripAnalysisBlock(body: string) {
	return body.replace(ANALYSIS_BLOCK_PATTERN, "\n").trimEnd();
}

export function hasAnalysisBlock(body: string) {
	return body.includes(START_MARKER);
}

export function appendAnalysisBlock(description: string, analysis: string) {
	return `${description}\n\n${START_MARKER}\n---\n\n${analysis}\n${END_MARKER}\n`;
}

export function wrapAnalysisComment(analysis: string) {
	return `${START_MARKER}\n${analysis}\n${END_MARKER}`;
}

export function isAnalysisComment(body: string) {
	return body.startsWith(START_MARKER);
}
