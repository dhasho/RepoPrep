# RepoPrep real evaluation corpus

`corpus.json` is the authoritative fact set for real repository evaluation: each case records the upstream commit, declared direct runtime dependency count, evidence-file SHA-256 values, and interview facts with line-level evidence (question, reference answer, follow-ups, pitfalls, keywords). Facts are written in Chinese for RepoPrep's interview-oriented evaluation. Keywords are review signals only; they do not establish correctness by themselves. This file describes sources and usage; consult `corpus.json` for the facts, versions, and hashes themselves.

## Fixed cases

| Case | Fixed commit | Split | Facts | License | Permanent source links |
| --- | --- | ---: | ---: | --- | --- |
| [developit/mitt](https://github.com/developit/mitt) | `6b41670516ed8e8b738612f60491995470aa63b3` | development | 6 | MIT | [src/index.ts](https://github.com/developit/mitt/blob/6b41670516ed8e8b738612f60491995470aa63b3/src/index.ts), [test/index_test.ts](https://github.com/developit/mitt/blob/6b41670516ed8e8b738612f60491995470aa63b3/test/index_test.ts) |
| [sindresorhus/p-limit](https://github.com/sindresorhus/p-limit) | `a8a6fbec4e0e866d6d779b10889bb4f5567e70eb` | development | 7 | MIT | [index.js](https://github.com/sindresorhus/p-limit/blob/a8a6fbec4e0e866d6d779b10889bb4f5567e70eb/index.js), [test.js](https://github.com/sindresorhus/p-limit/blob/a8a6fbec4e0e866d6d779b10889bb4f5567e70eb/test.js), [package.json](https://github.com/sindresorhus/p-limit/blob/a8a6fbec4e0e866d6d779b10889bb4f5567e70eb/package.json) |
| [dbader/schedule](https://github.com/dbader/schedule) | `82a43db1b938d8fdf60103bd41f329e06c8d3651` | development | 7 | MIT | [schedule/__init__.py](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/schedule/__init__.py), [test_schedule.py](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/test_schedule.py), [setup.py](https://github.com/dbader/schedule/blob/82a43db1b938d8fdf60103bd41f329e06c8d3651/setup.py) |
| [psf/requests](https://github.com/psf/requests) | `611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60` | holdout | 8 | Apache-2.0 | [sessions.py](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/src/requests/sessions.py), [models.py](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/src/requests/models.py), [pyproject.toml](https://github.com/psf/requests/blob/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60/pyproject.toml) |

Cases were selected as small, low-dependency public implementations with focused tests (mitt: TypeScript event emitter with no runtime dependencies; p-limit: async concurrency queue with one; schedule: Python job scheduler with none required; Requests: widely used Python HTTP client with session, preparation, streaming, and response behavior). The line ranges recorded in `corpus.json` are the authoritative fact citations; the links above address the same files at each pinned commit.

## Recreate the pinned checkouts

Clone each repository without checking out its default branch, then detach at the recorded commit:

```sh
git clone --no-checkout https://github.com/developit/mitt.git mitt
git -C mitt checkout --detach 6b41670516ed8e8b738612f60491995470aa63b3

git clone --no-checkout https://github.com/sindresorhus/p-limit.git p-limit
git -C p-limit checkout --detach a8a6fbec4e0e866d6d779b10889bb4f5567e70eb

git clone --no-checkout https://github.com/dbader/schedule.git schedule
git -C schedule checkout --detach 82a43db1b938d8fdf60103bd41f329e06c8d3651

git clone --no-checkout https://github.com/psf/requests.git requests
git -C requests checkout --detach 611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60
```

Reading these files requires no installation of upstream development dependencies. `evidenceHashMode: "utf8-lf"` means each complete evidence file is decoded as UTF-8, only CRLF pairs are normalized to LF, and SHA-256 is calculated over the resulting UTF-8 bytes. This makes the recorded evidence hashes independent of Windows versus LF checkout line endings; the pinned clone commands do not depend on a Git-wide `core.autocrlf` setting. Any `promptHash` created for an evaluation must still hash the actual prompt input bytes/text as submitted, without applying this evidence-file normalization.

## Verify and evaluate

`npm run eval:real -- verify --repos-root <directory>` checks every case before any evaluation: HEAD at the recorded commit, clean working tree, matching GitHub remote identity, each evidence file's SHA-256, and that every fact's evidence line ranges exist in the cited file. Verification reads no user settings or credentials and calls no model. Running a real evaluation is described in [the real evaluation guide](../../../docs/real-generation-evaluation.md); the recorded runs are indexed in [reports/README.md](../../../reports/README.md).

## Facts are isolated from model input

The fact list lives in RepoPrep's evaluation scripts (`corpus.json`), never inside the scanned repositories. It is used for corpus verification and, after generation, for keyword-coverage scoring and source review; facts, reference answers, and keywords never enter scan results, prompts, or model requests. The `fixtureHashes` recorded in reports are the upstream evidence files themselves.

## Limits

This is a small, manually curated snapshot of four public repositories, not a representative sample of software engineering as a whole. Facts describe only the cited files at the pinned commits. The corpus does not encode every project behavior, transitive dependency, deployment assumption, or cross-platform outcome. `requests` was designated the sole holdout case; performance on it alone does not establish generalization to other repositories or languages, and all four cases have since been used as development and regression samples. `development` and `holdout` identify evaluation splits, not claims about project quality.

## Attribution and licenses

The repositories remain under their upstream licenses: mitt, p-limit, and schedule are MIT; Requests is Apache-2.0. This corpus stores original Chinese summaries, questions, and answer guidance, not copied upstream source. Preserve each project's license and copyright notices when obtaining or redistributing its source; the upstream repositories contain the full notices.
