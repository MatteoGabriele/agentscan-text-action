import { describe, expect, it } from "vitest";
import { toAdopters } from "./collect-adopters";

const repository = (nameWithOwner: string, stargazerCount: number) => ({
	nameWithOwner,
	url: `https://github.com/${nameWithOwner}`,
	stargazerCount,
	owner: { avatarUrl: "https://avatars.githubusercontent.com/u/1?s=50" },
});

describe("toAdopters", () => {
	it("sorts by stars, descending", () => {
		const adopters = toAdopters([
			repository("owner/low", 3),
			repository("owner/high", 90),
			repository("owner/mid", 12),
		]);

		expect(adopters.map((item) => item.name)).toEqual([
			"owner/high",
			"owner/mid",
			"owner/low",
		]);
	});

	it("breaks ties by name, so an unchanged run produces no diff", () => {
		const adopters = toAdopters([
			repository("owner/c", 5),
			repository("owner/a", 5),
			repository("owner/b", 5),
		]);

		expect(adopters.map((item) => item.name)).toEqual([
			"owner/a",
			"owner/b",
			"owner/c",
		]);
	});

	it("leaves out the action's own repository, under any name", () => {
		const adopters = toAdopters([
			repository("MatteoGabriele/interlinked-action", 100),
			repository("MatteoGabriele/agentscan-text-action", 100),
			repository("owner/repo", 1),
		]);

		expect(adopters.map((item) => item.name)).toEqual(["owner/repo"]);
	});

	it("maps repository fields", () => {
		expect(toAdopters([repository("owner/repo", 7)])).toEqual([
			{
				name: "owner/repo",
				url: "https://github.com/owner/repo",
				stars: 7,
				avatar: "https://avatars.githubusercontent.com/u/1?s=50",
			},
		]);
	});
});
