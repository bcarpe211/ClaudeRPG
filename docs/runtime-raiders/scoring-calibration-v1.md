# Raid Power scoring calibration v1

**Status:** Active immutable calibration evidence
**Audience:** Policy and scoring reviewers
**Applies to:** Raid Power scoring policy v1
**Last verified:** 2026-08-28

Overall baseline weighted usage: 42715

| Workload | Surface | Samples | Median weighted usage | Median duration ms | Median Raid Power |
| --- | --- | ---: | ---: | ---: | ---: |
| Short Explanation | Codex Desktop | 3 | 24208 | 12423 | 25178 |
| Short Explanation | Codex CLI | 3 | 21169 | 10354 | 22143 |
| Small Code Edit | Codex Desktop | 3 | 34020 | 57141 | 35149 |
| Small Code Edit | Codex CLI | 3 | 34056 | 65856 | 35214 |
| Medium Repository Task | Codex Desktop | 3 | 47674 | 196067 | 49016 |
| Medium Repository Task | Codex CLI | 3 | 53243 | 245543 | 54643 |
| Long Reverse Engineering Analysis | Codex Desktop | 3 | 60365 | 388353 | 61939 |
| Long Reverse Engineering Analysis | Codex CLI | 3 | 68497 | 496591 | 70128 |

## Surface review

| Workload | Desktop median Raid Power | CLI median Raid Power | Difference | Review |
| --- | ---: | ---: | ---: | --- |
| Short Explanation | 25178 | 22143 | 12.05% | PASS |
| Small Code Edit | 35149 | 35214 | 0.18% | PASS |
| Medium Repository Task | 49016 | 54643 | 10.30% | PASS |
| Long Reverse Engineering Analysis | 61939 | 70128 | 11.68% | PASS |

Cross-provider comparison is inapplicable to v1.
Enabling Omp or Claude Code requires a new immutable policy version and a separate matched-provider calibration review; v1 must not be edited.
