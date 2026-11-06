# Agentic investigation protocol (offline controller)

`runInvestigation` is an opt-in, bounded controller component. It does not change the production static default. The separate scripted static investigator is the deterministic component policy `scripted-static-v1`; it is not the legacy generator baseline.

## Inputs and action protocol

The controller receives an immutable `RunSpec`, the matching project snapshot, evidence store, tool gateway, shared M05 budget ledger, model gateway, optional bounded objective, abort signal, and a metadata-only observer. It rejects mismatched project or snapshot identities before model or tool calls. The objective is fixed for the run; project text and tool previews are untrusted evidence, never system instructions. Initial file navigation includes only authorized file IDs, relative paths, byte lengths, and source kinds; the evidence pool is shown with a bounded ID preview while authorization checks use the full run-local pool.

Each model decision must return exactly `{"actions":[...]}`. An action is one of:

- `{"type":"request_tools","tools":[{"actionId":"...","tool":"...","args":{...}}]}` (up to eight tool actions per batch)
- `{"type":"propose_topics","topics":[{"id":"...","title":"...","mechanism":"...","valueRationale":"...","difficulty":"basic|intermediate|advanced","evidenceIds":[],"evidenceNeeds":[],"unconfirmed":[]}]}`
- `{"type":"select_evidence","selection":{"selectedIds":[],"requiredBundles":[{"id":"...","evidenceIds":[]}],"unresolved":[]}}`
- `{"type":"finish_investigation","unresolved":[]}`

Unknown actions, extra keys, invalid tool schemas, oversize responses, and malformed topic/selection values reject the whole decision before any tool call runs. Topics cannot carry answers or reference answers. All evidence IDs must already exist in the run store and resolve against its snapshot. A selected bundle can only contain IDs selected from that same actual pool; every topic's evidence must be included in the selection. The model cannot mint evidence records.

## Hard bounds and outcomes

The controller performs at most three actual decisions (including invalid responses), eight tool requests, 2 MiB of investigation reads, 18,000 input tokens, 6,000 output tokens, and 180 seconds, all through one shared M05 ledger. Calls are sequential; each output reservation is at most 2,000 tokens and shares the remaining investigation-output allowance across the remaining decision slots. If the resolved model budget leaves no investigation output capacity, it stops before a model call. Reaching the tool cap blocks additional tool actions but still allows a final bounded decision to select evidence and finish. `readRequests` counts source navigation/read tools and excludes `get_overview`; `repeatedReads` counts a repeated read only when it adds no previously presented evidence ID and repeats an already presented bounded preview, including cache hits. Two consecutive no-progress rounds or repeated identical action sets stop the controller. No retry creates a fresh ledger. Cancellation raises a static `WorkflowError('cancelled')`; no later action or observer callback runs.

Finishing without resolvable selected evidence returns `insufficient-evidence`. Other bounded stops return `limit-reached`; only a finished result with resolvable evidence returns `completed`. Missing provider usage remains unknown and is reflected by `usageComplete: false`. Trace callbacks contain only IDs, hashes, and static reason codes; callback failures do not affect the result.

The scripted static investigator uses the same snapshot, evidence store, tools, and ledger, performs no model calls, and reports evidence gaps as unresolved. Neither strategy persists results or includes raw errors in its result.

## Verification status

Offline fixtures exercise control flow and evidence plumbing with mocked M05 transport and synthetic usage only. They do not measure retrieval quality, task completion, cost on a real provider, or answer truth. The M06 real gate remains **not passed**: the frozen 20 tasks, each repeated twice, still need separate authorization and evaluation. No synthetic controller result counts as M06 completion.
