import type { TextClassification } from "@unveil/interlinked";
import { readBooleanInput, readInput, readListInput } from "./utils/inputs";
import { logWarning } from "./utils/workflow";

const MODES = ["full", "labels", "description", "silent"] as const;

export type Mode = (typeof MODES)[number];

const ANALYSIS_LOCATIONS = ["description", "comment"] as const;

export type AnalysisLocation = (typeof ANALYSIS_LOCATIONS)[number];

/** The classifications worth acting on, as in agentscan. */
const FLAGGED_CLASSIFICATIONS = ["mixed", "automation"] as const;

export type FlaggedClassification = (typeof FLAGGED_CLASSIFICATIONS)[number];

const KNOWN_AUTHOR_ASSOCIATIONS = [
	"collaborator",
	"contributor",
	"first_timer",
	"first_time_contributor",
	"member",
	"owner",
];

const DEFAULT_MODE: Mode = "labels";

const DEFAULT_ANALYSIS_LOCATION: AnalysisLocation = "comment";

const DEFAULT_TRUSTED_AUTHOR_ASSOCIATIONS = "member,owner";

const DEFAULT_AUTO_CLOSE_CLASSIFICATIONS = "automation";

/** Prefixed like agentscan's account labels, but distinct so both actions can run together. */
const DEFAULT_LABELS: Record<FlaggedClassification, string> = {
	mixed: "agentscan:mixed-text",
	automation: "agentscan:automated-text",
};

export interface Config {
	mode: Mode;
	analysisLocation: AnalysisLocation;
	allowedUsers: string[];
	trustedAuthorAssociations: string[];
	shouldCommentOnOrganic: boolean;
	labels: Record<FlaggedClassification, string>;
	messages: Partial<Record<TextClassification, string>>;
	shouldAutoClose: boolean;
	autoCloseClassifications: FlaggedClassification[];
	failOnClassifications: FlaggedClassification[];
}

export function readConfig(): Config {
	return {
		mode: readChoice("mode", MODES, DEFAULT_MODE),
		analysisLocation: readChoice(
			"analysis-location",
			ANALYSIS_LOCATIONS,
			DEFAULT_ANALYSIS_LOCATION,
		),
		allowedUsers: readListInput("allowed-users"),
		trustedAuthorAssociations: readListInput(
			"trusted-author-associations",
			DEFAULT_TRUSTED_AUTHOR_ASSOCIATIONS,
		).filter((association) => KNOWN_AUTHOR_ASSOCIATIONS.includes(association)),
		shouldCommentOnOrganic: readBooleanInput("comment-on-organic"),
		labels: {
			mixed: readInput("label-mixed") || DEFAULT_LABELS.mixed,
			automation: readInput("label-automation") || DEFAULT_LABELS.automation,
		},
		messages: {
			organic: readInput("message-organic"),
			mixed: readInput("message-mixed"),
			automation: readInput("message-automation"),
		},
		shouldAutoClose: readBooleanInput("auto-close"),
		autoCloseClassifications: readClassifications(
			"auto-close-classifications",
			DEFAULT_AUTO_CLOSE_CLASSIFICATIONS,
		),
		failOnClassifications: readClassifications("fail-on-classifications"),
	};
}

function readChoice<T extends string>(
	name: string,
	choices: readonly T[],
	fallback: T,
): T {
	const requested = readInput(name).toLowerCase() || fallback;

	if ((choices as readonly string[]).includes(requested)) {
		return requested as T;
	}

	logWarning(`Invalid ${name} "${requested}", falling back to "${fallback}".`);
	return fallback;
}

function readClassifications(name: string, fallback = "") {
	return readListInput(name, fallback).filter((item) => {
		if (isFlaggedClassification(item)) {
			return true;
		}

		logWarning(`Ignoring unknown classification "${item}" in ${name}.`);
		return false;
	}) as FlaggedClassification[];
}

export function isFlaggedClassification(
	classification: string,
): classification is FlaggedClassification {
	return (FLAGGED_CLASSIFICATIONS as readonly string[]).includes(
		classification,
	);
}

export function shouldPublishAnalysis(mode: Mode) {
	return mode === "full" || mode === "description";
}

export function shouldSyncLabel(mode: Mode) {
	return mode === "full" || mode === "labels";
}
