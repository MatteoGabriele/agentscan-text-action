import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeText, type TextClassification } from "@unveil/interlinked";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./run";

vi.mock("@unveil/interlinked", () => ({ analyzeText: vi.fn() }));

const REPO = "owner/repo";
const PR = 7;

interface Request {
	method: string;
	path: string;
	body?: unknown;
}

interface Setup {
	classification?: TextClassification;
	body?: string;
	author?: string;
	association?: string;
	inputs?: Record<string, string>;
	template?: string;
	comments?: object[];
}

let dir: string;
let requests: Request[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "interlinked-"));
	requests = [];
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

const SCORES: Record<TextClassification, number> = {
	organic: 90,
	mixed: 60,
	automation: 20,
	"insufficient-data": -1,
};

async function runAction({
	classification = "organic",
	body = "Fixes the thing.",
	author = "someone",
	association = "CONTRIBUTOR",
	inputs = {},
	template,
	comments = [],
}: Setup = {}) {
	vi.mocked(analyzeText).mockReturnValue({
		verdict: classification === "automation" ? "ai" : "human",
		classification,
		score: SCORES[classification],
		confidence: 0.8,
		signals: [],
	});

	const eventPath = join(dir, "event.json");
	writeFileSync(
		eventPath,
		JSON.stringify({
			pull_request: {
				number: PR,
				body,
				base: { sha: "base-sha" },
				user: { login: author },
				author_association: association,
			},
			repository: { full_name: REPO },
		}),
	);
	vi.stubEnv("GITHUB_EVENT_PATH", eventPath);
	vi.stubEnv("GITHUB_OUTPUT", join(dir, "output"));
	vi.stubEnv("GITHUB_STEP_SUMMARY", join(dir, "summary"));
	for (const [name, value] of Object.entries(inputs)) {
		vi.stubEnv(`INPUT_${name.toUpperCase()}`, value);
	}

	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			const path = url.replace("https://api.github.com", "");
			const method = init.method ?? "GET";
			if (method === "GET" && path.includes(`/issues/${PR}/comments`)) {
				return Response.json(comments);
			}
			if (method === "GET") {
				const found =
					template &&
					path.includes("/contents/.github/pull_request_template.md");
				return new Response(found ? template : "", {
					status: found ? 200 : 404,
				});
			}
			requests.push({
				method,
				path,
				body: init.body ? JSON.parse(String(init.body)) : undefined,
			});
			return new Response("{}");
		}),
	);

	await run();
}

function newBody() {
	const patch = requests.find(
		(r) =>
			r.path === `/repos/${REPO}/pulls/${PR}` && "body" in (r.body as object),
	);
	return (patch?.body as { body: string } | undefined)?.body;
}

function outputs() {
	return readFileSync(join(dir, "output"), "utf8");
}

describe("analysis", () => {
	it("writes the classification and score to the step outputs", async () => {
		await runAction({ classification: "automation" });

		expect(outputs()).toMatch(/classification<<\S+\nautomation\n/);
		expect(outputs()).toMatch(/score<<\S+\n20\n/);
	});

	it("passes the repo's PR template to the detector", async () => {
		await runAction({ template: "## Summary" });

		expect(analyzeText).toHaveBeenCalledWith(expect.any(String), {
			template: "## Summary",
		});
	});

	it("ignores its own previous analysis when scoring a rerun", async () => {
		await runAction({
			body: "Fixes the thing.",
			inputs: { mode: "full", "analysis-location": "description" },
		});
		const firstRunBody = newBody() as string;

		await runAction({ body: firstRunBody });

		expect(analyzeText).toHaveBeenLastCalledWith(
			"Fixes the thing.",
			expect.anything(),
		);
	});
});

describe("full mode", () => {
	it("appends the analysis to the PR description", async () => {
		await runAction({
			classification: "automation",
			body: "Fixes the thing.",
			inputs: { mode: "full", "analysis-location": "description" },
		});

		expect(newBody()).toMatch(
			/^Fixes the thing\.\n\n<!-- interlinked:start -->/,
		);
		expect(newBody()).toContain("Agent-style writing");
	});

	it.each([
		["automation", "label-automation", "agentscan:automated-text"],
		["mixed", "label-mixed", "agentscan:mixed-text"],
	] as const)(
		"adds the %s label",
		async (classification, input, defaultLabel) => {
			await runAction({ classification, inputs: { mode: "full" } });

			expect(requests).toContainEqual({
				method: "POST",
				path: `/repos/${REPO}/issues/${PR}/labels`,
				body: { labels: [defaultLabel] },
			});

			requests = [];
			await runAction({
				classification,
				inputs: { mode: "full", [input]: "bot" },
			});

			expect(requests).toContainEqual({
				method: "POST",
				path: `/repos/${REPO}/issues/${PR}/labels`,
				body: { labels: ["bot"] },
			});
		},
	);

	it.each(["organic", "insufficient-data"] as const)(
		"leaves labels alone when the description is %s",
		async (classification) => {
			await runAction({ classification, inputs: { mode: "full" } });

			expect(requests).not.toContainEqual(
				expect.objectContaining({
					path: expect.stringContaining(`/issues/${PR}/labels`),
				}),
			);
		},
	);

	it("replaces the default description with a custom message", async () => {
		await runAction({
			classification: "mixed",
			inputs: {
				mode: "full",
				"analysis-location": "description",
				"message-mixed": "Please rewrite this yourself.",
			},
		});

		expect(newBody()).toContain("Please rewrite this yourself.");
		expect(newBody()).not.toContain("partly like an agent");
	});
});

describe("organic descriptions", () => {
	const inputs = { mode: "description" };

	it("aren't commented on by default", async () => {
		await runAction({ classification: "organic", inputs });

		expect(requests).toEqual([]);
	});

	it("are commented on with comment-on-organic", async () => {
		await runAction({
			classification: "organic",
			inputs: { ...inputs, "comment-on-organic": "true" },
		});

		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			`POST /repos/${REPO}/issues/${PR}/comments`,
		]);
	});

	it("still update an earlier analysis comment", async () => {
		await runAction({
			classification: "organic",
			inputs,
			comments: [
				{
					id: 2,
					body: "<!-- interlinked:start -->\nold\n<!-- interlinked:end -->",
					user: { type: "Bot" },
				},
			],
		});

		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			`PATCH /repos/${REPO}/issues/comments/2`,
		]);
	});

	it("still update an earlier analysis block in the description", async () => {
		await runAction({
			classification: "organic",
			body: "Fixes the thing.\n\n<!-- interlinked:start -->\nold\n<!-- interlinked:end -->\n",
			inputs: { ...inputs, "analysis-location": "description" },
		});

		expect(newBody()).toContain("Organic writing");
	});

	it("leave a description without an analysis block alone", async () => {
		await runAction({
			classification: "insufficient-data",
			inputs: { ...inputs, "analysis-location": "description" },
		});

		expect(requests).toEqual([]);
	});
});

describe("insufficient data", () => {
	it("says so instead of showing a score", async () => {
		await runAction({
			classification: "insufficient-data",
			inputs: { mode: "description", "comment-on-organic": "true" },
		});

		const comment = requests[0]?.body as { body: string };
		expect(comment.body).toContain("Insufficient data");
		expect(comment.body).not.toContain("/100");
	});
});

describe("comment location", () => {
	const inputs = { mode: "description" };

	it("posts the analysis as a comment by default", async () => {
		await runAction({ classification: "automation", inputs });

		expect(newBody()).toBeUndefined();
		expect(requests).toContainEqual({
			method: "POST",
			path: `/repos/${REPO}/issues/${PR}/comments`,
			body: {
				body: expect.stringMatching(
					/^<!-- interlinked:start -->\n[\s\S]*Agent-style writing/,
				),
			},
		});
	});

	it("edits its previous comment on reruns", async () => {
		await runAction({
			inputs,
			comments: [
				{ id: 1, body: "Nice!", user: { type: "User" } },
				{
					id: 2,
					body: "<!-- interlinked:start -->\nold\n<!-- interlinked:end -->",
					user: { type: "Bot" },
				},
			],
		});

		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			`PATCH /repos/${REPO}/issues/comments/2`,
		]);
	});

	it("ignores marker comments written by people", async () => {
		await runAction({
			classification: "automation",
			inputs,
			comments: [
				{
					id: 3,
					body: "<!-- interlinked:start -->\nfake\n<!-- interlinked:end -->",
					user: { type: "User" },
				},
			],
		});

		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			`POST /repos/${REPO}/issues/${PR}/comments`,
		]);
	});
});

describe("modes", () => {
	it("only touches labels by default", async () => {
		await runAction({ classification: "automation" });

		expect(requests.map((r) => r.method)).toEqual(["POST"]);
	});

	it("only touches labels in labels mode", async () => {
		await runAction({
			classification: "automation",
			inputs: { mode: "labels" },
		});

		expect(requests.map((r) => r.method)).toEqual(["POST"]);
	});

	it("only publishes the analysis in description mode", async () => {
		await runAction({
			classification: "automation",
			inputs: { mode: "description" },
		});

		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			`POST /repos/${REPO}/issues/${PR}/comments`,
		]);
	});

	it("writes nothing back to the PR in silent mode", async () => {
		await runAction({
			classification: "automation",
			inputs: { mode: "silent" },
		});

		expect(requests).toEqual([]);
	});
});

describe("skipping", () => {
	it.each(["MEMBER", "OWNER"])(
		"skips %s authors by default",
		async (association) => {
			await runAction({ association });

			expect(analyzeText).not.toHaveBeenCalled();
		},
	);

	it("analyzes members when trusted associations are cleared", async () => {
		await runAction({
			association: "MEMBER",
			inputs: { "trusted-author-associations": "" },
		});

		expect(analyzeText).toHaveBeenCalled();
	});

	it("skips allowed users", async () => {
		await runAction({
			author: "Dependabot",
			inputs: { "allowed-users": '["dependabot"]' },
		});

		expect(analyzeText).not.toHaveBeenCalled();
	});

	it("skips trusted author associations", async () => {
		await runAction({
			association: "MEMBER",
			inputs: { "trusted-author-associations": "owner, member" },
		});

		expect(analyzeText).not.toHaveBeenCalled();
	});
});

describe("enforcement", () => {
	it("closes the PR when auto-close is on and it's classified as automation", async () => {
		await runAction({
			classification: "automation",
			inputs: { "auto-close": "true" },
		});

		expect(requests).toContainEqual({
			method: "PATCH",
			path: `/repos/${REPO}/pulls/${PR}`,
			body: { state: "closed" },
		});
	});

	it("leaves mixed PRs open unless auto-close-classifications includes mixed", async () => {
		await runAction({
			classification: "mixed",
			inputs: { "auto-close": "true" },
		});

		expect(requests).not.toContainEqual(
			expect.objectContaining({ body: { state: "closed" } }),
		);

		await runAction({
			classification: "mixed",
			inputs: {
				"auto-close": "true",
				"auto-close-classifications": "mixed, automation",
			},
		});

		expect(requests).toContainEqual(
			expect.objectContaining({ body: { state: "closed" } }),
		);
	});

	it("fails the step for the classifications in fail-on-classifications", async () => {
		await runAction({
			classification: "automation",
			inputs: { "fail-on-classifications": '["automation"]' },
		});

		expect(process.exitCode).toBe(1);
	});

	it("passes by default, whatever the classification", async () => {
		await runAction({ classification: "automation" });

		expect(process.exitCode).toBeUndefined();
	});

	it("leaves organic PRs open and passing", async () => {
		await runAction({
			classification: "organic",
			inputs: {
				"auto-close": "true",
				"auto-close-classifications": "mixed,automation",
				"fail-on-classifications": "mixed,automation",
			},
		});

		expect(requests).not.toContainEqual(
			expect.objectContaining({ body: { state: "closed" } }),
		);
		expect(process.exitCode).toBeUndefined();
	});
});
