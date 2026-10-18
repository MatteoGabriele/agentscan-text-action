/**
 * Collect the public repositories using this action into data/adopters.json.
 *
 * Code search is rate limited to 10 requests a minute, so run it by hand every
 * now and then with `pnpm collect:adopters` and commit the file.
 *
 * Credentials come from .env:
 *   GITHUB_TOKEN  a token that may search code across public repos
 */

import fs from "node:fs";
import path from "node:path";

export interface AdopterRepository {
	name: string;
	url: string;
	stars: number;
	avatar: string;
}

interface RepositoryNode {
	nameWithOwner: string;
	url: string;
	stargazerCount: number;
	owner: {
		avatarUrl: string;
	};
}

interface CodeSearchResponse {
	items: { repository: { node_id: string } }[];
}

const API_URL = process.env.GITHUB_API_URL ?? "https://api.github.com";
const SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_PAGES = 5;
const NODE_BATCH_SIZE = 100;
const AVATAR_SIZE = 50;
// The action's own repository, under every name it has had, isn't an adopter.
const SELF = new Set([
	"MatteoGabriele/interlinked-action",
	"MatteoGabriele/agentscan-text-action",
]);
// GitHub redirects renamed repositories, so workflows keep working under an
// old name and every name has to be searched. "MatteoGabriele/interlinked"
// also matches MatteoGabriele/interlinked-action.
const ACTION_NAMES = [
	"MatteoGabriele/interlinked",
	"MatteoGabriele/agentscan-text-action",
];

const OUTPUT_PATH = "data/adopters.json";

const repositoryQuery = `
  query ($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Repository {
        nameWithOwner
        url
        stargazerCount
        owner {
          avatarUrl(size: ${AVATAR_SIZE})
        }
      }
    }
  }
`;

async function githubRequest<T>(
	token: string,
	endpoint: string,
	init: RequestInit = {},
): Promise<T> {
	const response = await fetch(`${API_URL}${endpoint}`, {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			Authorization: `Bearer ${token}`,
			...init.headers,
		},
	});

	if (!response.ok) {
		throw new Error(
			`${init.method ?? "GET"} ${endpoint} failed: ${response.status} ${await response.text()}`,
		);
	}

	return (await response.json()) as T;
}

async function searchRepositoryIds(token: string, actionName: string) {
	const ids = new Set<string>();

	for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
		const params = new URLSearchParams({
			q: `"${actionName}" path:.github/workflows -is:fork`,
			per_page: String(SEARCH_PAGE_SIZE),
			page: String(page),
		});
		const data = await githubRequest<CodeSearchResponse>(
			token,
			`/search/code?${params}`,
		);

		for (const item of data.items) {
			ids.add(item.repository.node_id);
		}

		if (data.items.length < SEARCH_PAGE_SIZE) {
			break;
		}
	}

	return [...ids];
}

async function fetchRepositories(token: string, ids: string[]) {
	const batches: string[][] = [];

	for (let index = 0; index < ids.length; index += NODE_BATCH_SIZE) {
		batches.push(ids.slice(index, index + NODE_BATCH_SIZE));
	}

	const responses = await Promise.all(
		batches.map(async (batch) => {
			const response = await githubRequest<{
				data?: { nodes: (RepositoryNode | null)[] };
				errors?: { message: string }[];
			}>(token, "/graphql", {
				method: "POST",
				body: JSON.stringify({
					query: repositoryQuery,
					variables: { ids: batch },
				}),
			});

			if (!response.data) {
				throw new Error(
					`GraphQL query failed: ${response.errors?.map((error) => error.message).join(", ")}`,
				);
			}

			return response.data;
		}),
	);

	return responses
		.flatMap((response) => response.nodes)
		.filter((node) => node !== null);
}

/**
 * Sorted by stars, with ties broken by name so a run without star changes
 * produces no diff at all. The action's own repository isn't an adopter.
 */
export function toAdopters(
	repositories: RepositoryNode[],
): AdopterRepository[] {
	return repositories
		.filter((repository) => !SELF.has(repository.nameWithOwner))
		.map((repository) => ({
			name: repository.nameWithOwner,
			url: repository.url,
			stars: repository.stargazerCount,
			avatar: repository.owner.avatarUrl,
		}))
		.sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));
}

// The action leaves a workflow file behind, so adopters are found by searching
// for it.
export async function collectAdopters(token: string) {
	const ids = new Set<string>();

	// One name at a time: code search is rate limited, so no parallel requests.
	for (const actionName of ACTION_NAMES) {
		for (const id of await searchRepositoryIds(token, actionName)) {
			ids.add(id);
		}
	}

	if (ids.size === 0) {
		return [];
	}

	return toAdopters(await fetchRepositories(token, [...ids]));
}

async function main() {
	const dryRun = process.argv.slice(2).includes("--dry-run");
	const token = process.env.GITHUB_TOKEN;

	if (!token) {
		console.error("✗ Missing GITHUB_TOKEN in .env");
		process.exit(1);
	}

	const adopters = await collectAdopters(token);

	console.log(`📋 ${adopters.length} adopter(s)`);

	// An empty result means the search broke, not that every adopter left, so
	// keep whatever is already committed.
	if (adopters.length === 0) {
		console.error("✗ No adopters found — leaving the existing file untouched");
		process.exit(1);
	}

	if (dryRun) {
		console.log(JSON.stringify(adopters, null, 2));
		return;
	}

	const outputPath = path.join(process.cwd(), OUTPUT_PATH);
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, `${JSON.stringify(adopters, null, 2)}\n`);
	console.log(`✓ Wrote ${OUTPUT_PATH}`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("Error:", (err as Error).message);
		process.exit(1);
	});
}
