import type {
	AnalyzeTextResult,
	TextClassification,
} from "@unveil/interlinked";

type Signal = AnalyzeTextResult["signals"][number];

const ICONS_BASE_URL =
	"https://raw.githubusercontent.com/MatteoGabriele/agentscan-text-action/main/icons";

/** Worded like agentscan's account classifications, for text. */
const CLASSIFICATION_DETAILS: Record<
	TextClassification,
	{ icon: string; label: string; description: string }
> = {
	organic: {
		icon: "heart-handshake",
		label: "Organic writing",
		description: "Reads like a person wrote it.",
	},
	mixed: {
		icon: "shield-question-mark",
		label: "Mixed writing",
		description:
			"Reads partly like a person and partly like an agent wrote it.",
	},
	automation: {
		icon: "shield-alert",
		label: "Agent-style writing",
		description: "Reads like an agent wrote it.",
	},
	"insufficient-data": {
		icon: "circle-dashed",
		label: "Insufficient data",
		description: "Not enough text to make a reliable assessment.",
	},
};

function renderIcon(name: string) {
	return `<picture><img src="${ICONS_BASE_URL}/${name}.svg" width="16" height="16" alt=""></picture>`;
}

function renderHeading(result: AnalyzeTextResult) {
	const details = CLASSIFICATION_DETAILS[result.classification];
	const heading = `${renderIcon(details.icon)} **${details.label}**`;

	if (result.classification === "insufficient-data") {
		return heading;
	}

	return `${heading} · score ${Math.round(result.score)}/100`;
}

function formatContribution(contribution: number) {
	return `${contribution > 0 ? "+" : ""}${contribution}`;
}

function renderSignalsTable(signals: Signal[]) {
	const rows = signals.map(
		(signal) =>
			`| ${signal.description} | ${signal.hits} | ${formatContribution(signal.contribution)} |`,
	);

	return [
		"<details><summary>Signals</summary>",
		"",
		"| Signal | Hits | Contribution |",
		"| --- | --- | --- |",
		...rows,
		"",
		"</details>",
	].join("\n");
}

/** A custom message replaces the classification's description, as in agentscan. */
export function renderAnalysis(result: AnalyzeTextResult, customMessage = "") {
	const sections = [
		renderHeading(result),
		customMessage || CLASSIFICATION_DETAILS[result.classification].description,
	];

	if (result.signals.length > 0) {
		sections.push(renderSignalsTable(result.signals));
	}

	return sections.join("\n\n");
}
