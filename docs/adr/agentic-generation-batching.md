# Bound redundant fine evidence batches

Status: planned writer-v4 batch policy; M08 remains incomplete.

## Evidence

Candidate `3505174` completed five cells, including a 32-question fine control, then stopped on the paired fine candidate at 24 questions and the 65,536-output-token limit. All sixteen receipts are complete: 37,341 input and 256,107 output tokens. Eighteen original report/journal/cell artifacts were hash-verified and retained. This is an incomplete cohort, not a quality pass.

Numeric inspection of successful outputs found medium main-answer means of 169–235 characters and two follow-ups per question; the completed fine output had 32 questions, main-answer mean 229, follow-up mean 74 and 29,488 normalized JSON characters, versus 64,437 provider completion tokens. Characters and tokens are different units. No reasoning-token breakdown was retained, so these observations cannot establish its exact share.

The adapter's grouping code unconditionally fills four fine groups. The component experiment supplies one atomic fixed-evidence bundle, so all four groups repeat the same sources. That repeated dispatch overhead is avoidable without dropping any required evidence or changing the requested question target.

## Decision

For fine evidence-aware generation, use `min(maxGroups, max(2, componentCount))` groups, bounded by remaining model calls; maxGroups remains four. Components are the existing deterministic union of required bundles and topic references. Thus one or two components use two groups, three use three, and four or more retain four. Replicate whole components only to reach the two-group floor. Coarse and medium policies remain unchanged.

Keep all shared minimum/target/maximum question counts; in this frozen one-bundle fine experiment the unchanged target of 32 is allocated over two equal groups. Both writers use identical grouping, writing guidance, evidence and hard limits. Required bundles remain atomic, all sources still pass M07, and final response/quantity/citation validation is unchanged. Do not accept truncated model responses, lower question counts, enlarge output caps, change reasoning/model settings or add retries in this work package. Writer version advances to v4 to distinguish its dispatch policy; v3 text guidance remains.

## Verification and measurement

Exercise actual fine dispatch quotas and sidecar lineage at the unchanged cumulative output boundary, plus one-/two-/three-/four-component grouping and required-combination preservation. Verify the full synthetic matrix uses the new deterministic base call count while the frozen 5/14 per-run and 420 full-matrix maximums remain intact. Keep default static equivalence and hard failure behavior.

A later real run uses a new immutable source/reference and the full 48-cell matrix. No old successful cell is spliced into it. Prior M08 totals are 31 requests, 30 known receipts (66,916 input / 487,255 output) and the original one-request unknown held at 2,813/32,768. The remaining ceiling is 389 requests, 6,074,271 input admission and 2,625,705 output allowance. All fixed quality thresholds remain unchanged; success is still determined by complete execution and independent blind review.
