<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./interlinked-dark.svg">
    <img src="./interlinked.svg" alt="AgentScan Text logo" width="120">
  </picture>
</p>

<h1 align="center">AgentScan Text Action</h1>

<p align="center">
  <a href="https://github.com/MatteoGabriele/agentscan-text-action/releases/latest"><img src="https://img.shields.io/github/v/release/MatteoGabriele/agentscan-text-action?label=release&color=8b5cf6" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/runtime-node24-339933?logo=nodedotjs&logoColor=white" alt="Runs on Node 24">
  <a href="./package.json"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

Runs the [interlinked](https://github.com/unveil-project/interlinked) detector on a pull request's description and classifies it the way [agentscan](https://agentscan.tools) classifies accounts: `organic`, `mixed`, `automation`, or `insufficient-data` when there's too little text to judge. Mixed and automation PRs get a label. In `full` and `description` modes the action also publishes the analysis, as a PR comment by default or appended to the description inside an `<!-- interlinked:start -->` … `<!-- interlinked:end -->` block. Later runs edit that comment or block in place, and the block is stripped before analysis so it never affects the score.

```yaml
name: AgentScan Text

on:
  pull_request_target:
    types: [opened, edited, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: MatteoGabriele/agentscan-text-action@v0.4
```

Use `pull_request_target` so the token can write to PRs from forks. The action never checks out or runs PR code, so that's safe here. Edits made with the default `GITHUB_TOKEN` don't trigger new workflow runs, so updating the description or comment doesn't loop.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | Reads the PR template, updates the description, manages labels. |
| `allowed-users` | | Usernames to skip, comma-separated or as a JSON array. |
| `trusted-author-associations` | `member,owner` | Author associations to skip (`collaborator`, `contributor`, `first_timer`, `first_time_contributor`, `member`, `owner`), comma-separated or as a JSON array. Set to `""` to analyze everyone. |
| `mode` | `labels` | `full` (description and labels), `labels` (labels only), `description` (description only) or `silent` (outputs and job summary only). |
| `analysis-location` | `comment` | Where `full` and `description` modes publish the analysis: `comment` (a separate PR comment, edited in place on reruns) or `description` (appended to the PR description). See the warning below. |
| `comment-on-organic` | `false` | Publish the analysis for `organic` and `insufficient-data` descriptions too. Either way, an earlier run's analysis is brought up to date, so an edit that clears a flag doesn't leave the old verdict behind. |
| `label-mixed` | `agentscan:mixed-text` | Label to add when the classification is `mixed`. |
| `label-automation` | `agentscan:automated-text` | Label to add when the classification is `automation`. |
| `auto-close` | `false` | Close the PR when its classification is in `auto-close-classifications`. |
| `auto-close-classifications` | `automation` | Classifications that trigger auto-close (`mixed`, `automation`), comma-separated or as a JSON array. |
| `fail-on-classifications` | | Classifications that fail the step (`mixed`, `automation`), comma-separated or as a JSON array. Empty, so the step never fails. |
| `message-organic` / `message-mixed` / `message-automation` | | Custom message per classification, shown in place of the default one. |

Labels are never removed automatically, so editing the description can't clear them; a maintainer removes them.

These follow the same conventions as [agentscan-action](https://github.com/MatteoGabriele/agentscan-action). The default labels share its `agentscan:` prefix but differ from its account labels, so both actions can run on the same PR.

> [!WARNING]
> With `analysis-location: description`, the analysis lives in text the PR author controls. They can edit or delete it, or rewrite it to say the opposite. The label and the default comment can only be changed by maintainers, so rely on those for anything you enforce.

## Outputs

| Output | Description |
| --- | --- |
| `classification` | `organic`, `mixed`, `automation`, or `insufficient-data`. |
| `score` | How human the description reads, 0 to 100 with 100 human, on the same scale as agentscan's account score. `-1` with insufficient data. Below 50 is `automation`, 70 and up is `organic`. |
| `confidence` | Confidence in the classification, 0.5 to 1. |
| `signals` | The signals that fired, as JSON. |

The analysis is also written to the job summary.
