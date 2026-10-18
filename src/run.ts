import { readFileSync } from "node:fs";
import { type AnalyzeTextResult, analyzeText } from "@unveil/interlinked";
import {
	appendAnalysisBlock,
	hasAnalysisBlock,
	stripAnalysisBlock,
	wrapAnalysisComment,
} from "./analysis/marker";
import { renderAnalysis } from "./analysis/render";
import {
	type Config,
	isFlaggedClassification,
	readConfig,
	shouldPublishAnalysis,
	shouldSyncLabel,
} from "./config";
import { upsertAnalysisComment } from "./github/comments";
import { addLabel } from "./github/labels";
import { closePullRequest, updatePullRequestBody } from "./github/pull-request";
import { fetchPullRequestTemplate } from "./github/template";
import type { PullRequest, PullRequestEvent } from "./types";
import {
	appendJobSummary,
	logError,
	logWarning,
	setOutput,
} from "./utils/workflow";

function readPullRequestEvent(): PullRequestEvent {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) {
		throw new Error(
			"GITHUB_EVENT_PATH is not set. Is this running in Actions?",
		);
	}

	return JSON.parse(readFileSync(eventPath, "utf8"));
}

function findSkipReason(pull: PullRequest, config: Config) {
	const author = pull.user.login;

	if (config.allowedUsers.includes(author.toLowerCase())) {
		return `Skipping analysis for ${author}`;
	}

	const association = pull.author_association?.toLowerCase();
	if (association && config.trustedAuthorAssociations.includes(association)) {
		return `Skipping analysis for ${author} (trusted author association: ${association})`;
	}

	return undefined;
}

async function fetchTemplateSafely(repo: string, ref: string) {
	try {
		return await fetchPullRequestTemplate(repo, ref);
	} catch (error) {
		logWarning(
			`Couldn't fetch the PR template, analyzing without it: ${(error as Error).message}`,
		);
		return undefined;
	}
}

function publishOutputs(result: AnalyzeTextResult) {
	setOutput("classification", result.classification);
	setOutput("score", String(result.score));
	setOutput("confidence", String(result.confidence));
	setOutput("signals", JSON.stringify(result.signals));
}

function warnOnError(error: Error) {
	logWarning(error.message);
}

/**
 * With `createIfMissing` off, only a previous run's analysis is brought up to
 * date, so an edit that clears a flag doesn't leave the old verdict behind.
 */
async function publishAnalysis(
	pull: PullRequest,
	repo: string,
	description: string,
	analysis: string,
	config: Config,
	createIfMissing: boolean,
) {
	if (config.analysisLocation === "comment") {
		await upsertAnalysisComment(
			repo,
			pull.number,
			wrapAnalysisComment(analysis),
			{ createIfMissing },
		);
		return;
	}

	if (!createIfMissing && !hasAnalysisBlock(pull.body ?? "")) {
		return;
	}

	const updatedBody = appendAnalysisBlock(description, analysis);
	if (updatedBody !== pull.body) {
		await updatePullRequestBody(repo, pull.number, updatedBody);
	}
}

export async function run() {
	const event = readPullRequestEvent();
	const pull = event.pull_request;
	if (!pull) {
		logWarning(
			"No pull request in this event. Run on pull_request or pull_request_target.",
		);
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

	if (shouldPublishAnalysis(config.mode)) {
		// Organic and insufficient-data PRs get no new comment unless asked, as in agentscan.
		const createIfMissing = isFlagged || config.shouldCommentOnOrganic;
		await publishAnalysis(
			pull,
			repo,
			description,
			analysis,
			config,
			createIfMissing,
		).catch(warnOnError);
	}

	if (!isFlagged) {
		return;
	}

	if (shouldSyncLabel(config.mode)) {
		await addLabel(repo, pull.number, config.labels[classification]).catch(
			warnOnError,
		);
	}

	if (
		config.shouldAutoClose &&
		config.autoCloseClassifications.includes(classification)
	) {
		await closePullRequest(repo, pull.number).catch(warnOnError);
	}

	if (config.failOnClassifications.includes(classification)) {
		logError(`The PR description is classified as ${classification}.`);
		process.exitCode = 1;
	}
}
