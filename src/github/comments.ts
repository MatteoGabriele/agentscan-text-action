import { isAnalysisComment } from "../analysis/marker";
import { githubRequest, warnOnFailedResponse } from "../utils/github-api";

interface IssueComment {
	id: number;
	body?: string;
	user: { type: string } | null;
}

/** Only bot comments count, so a commenter can't plant one for us to overwrite. */
async function findAnalysisComment(repo: string, pullNumber: number) {
	const response = await githubRequest(
		`/repos/${repo}/issues/${pullNumber}/comments?per_page=100`,
	);

	if (!response.ok) {
		return undefined;
	}

	const comments = (await response.json()) as IssueComment[];
	return comments.find((comment) => {
		return (
			comment.user?.type === "Bot" && isAnalysisComment(comment.body ?? "")
		);
	});
}

/**
 * Edits the previous run's comment in place instead of posting a new one each
 * run. With `createIfMissing` off, it only ever edits.
 */
export async function upsertAnalysisComment(
	repo: string,
	pullNumber: number,
	body: string,
	{ createIfMissing = true } = {},
) {
	const existing = await findAnalysisComment(repo, pullNumber);

	if (!existing && !createIfMissing) {
		return;
	}

	let response: Response | undefined;

	if (existing) {
		response = await githubRequest(
			`/repos/${repo}/issues/comments/${existing.id}`,
			{
				method: "PATCH",
				body: JSON.stringify({ body }),
			},
		);
	} else {
		response = await githubRequest(
			`/repos/${repo}/issues/${pullNumber}/comments`,
			{
				method: "POST",
				body: JSON.stringify({ body }),
			},
		);
	}

	await warnOnFailedResponse(response, "Couldn't post the analysis comment");
}
