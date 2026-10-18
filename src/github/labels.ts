import { githubRequest, warnOnFailedResponse } from "../utils/github-api";

export async function addLabel(
	repo: string,
	pullNumber: number,
	label: string,
) {
	const response = await githubRequest(
		`/repos/${repo}/issues/${pullNumber}/labels`,
		{
			method: "POST",
			body: JSON.stringify({ labels: [label] }),
		},
	);

	await warnOnFailedResponse(response, `Couldn't add label "${label}"`);
}
