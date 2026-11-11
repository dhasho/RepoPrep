# Component read context and historical ledger validation

Date: 2026-11-11. Status: B03b2b implementation proposal; root review/integration pending.

## Problem

A ledger V1 payload contains the exact original ledger binding and original time/budget rules. A writer for RunSpec B must not use B's payload-only validator to decode an older terminal for A while carrying the same W storage root. Both records can legitimately use workflow-ledger-state-v1. Remembering ambient specs in a run-ID map cannot prove which original spec belongs to the actual W journal containing a component.

## W contract

A captured component validator may supply synchronous validateRead(payload, context). The current validate(payload) remains mandatory and is used for every write and read-back before publication. An exact matching current/historical schema descriptor chooses its own read callback; false, exceptions, non-literal-true and promise results fail closed with no fallback. critical-journal descriptors cannot configure validateRead. Descriptor capture rejects accessors/proxies and async/generator functions before the first await.

W first verifies owner/control/attempt ancestry, all journal outer bytes/references/codecs, all manifest and component outer bytes/hashes/bindings/epochs/schema pins/size ceilings, and inherited journal/manifest head membership. Component payload callbacks run only after the complete outer view passes. Context success does not mean component schema validity until literal true returns. Visible-response policy remains an independent required guard.

Each context is an empty frozen token in a private WeakMap. It is valid only for one synchronous callback, deleted in finally on every return/throw path. The inspector rejects copies/proxies/retained or asynchronous use. It checks root and genuine owner fences on inspection, and W checks them around the callback and before a view escapes. The immutable view includes binding, current epoch, exact component reference, its actual containing manifest and reference, plus one verified journal array identity shared by every component in that view. It exposes no filesystem path/raw unverified JSON, writer, receipt, ledger, source, restore or continuation authority. Retaining an inspected immutable data snapshot creates no capability.

Journal and manifest/reference graphs are deeply frozen before issuance. The read-view wrapper uses Object.freeze over already deeply frozen fields, avoiding repeated deep walks of the full shared journal for every historical component. This does not use a global Object.isFrozen shortcut that could trust shallow-frozen children.

## Fixed archival ledger decoder

The host registers validateArchivedWorkflowLedger for ledger reads during genuine open/carry and readOwned paths, while its original current-spec validate closure stays unchanged. This internal selection is not caller-configurable. classifyWorkflowLedger already receives the exact requested original spec and binding, so that single-run read uses the original exact-spec payload validator and then the unchanged full fold and anchor/projection/stage checks. In particular a missing anchor fails generic archival reads but remains manifest-mismatch(anchor) in known-spec classification; this is separate internal routing, with no decoder fallback. The archival decoder only accepts a genuine active W context for exact ledger V1. It prepares the canonical originalSpecJson from the exact verified critical view, checks its entire original W binding, fixed critical schema, uniform original spec/version, sequence/epoch/full previous-reference provenance, and folds the complete actual causal view through the existing unchanged transition rules. The containing manifest must have an exact full journalPosition reference in that view; missing, foreign, torn, mixed or unknown chains fail closed. The original validateLedgerState(originalSpec, payload) then validates the component schema.

Only immutable fold facts are cached under the W-issued journal-array identity in a private WeakMap. No global run/spec index or duplicate large ledger states are retained, and every call rechecks its active private context and binding. The cached facts confer no authority.

Projection equality against the anchored state, stage/outcome, latest-tail/sole-component, live owner and original accounting checks remain in the genuine host. A schema-valid differing projection still reaches its existing manifest-mismatch diagnostic. Schema success is not terminal or business acceptance. This slice changes no outer W format, V1 codec/byte commitment, limit, registry/queue/fence, provider/native/UI/default/IPC or generation behavior. Critical V2 and lineage/plan issuance remain later work.

## Validation

The new suites use real W disk records, owner/attempt APIs and genuine cancellation lifecycle to cover distinct A/B original specs in a shared root, exact B writes, old manifest anchors/new tails, retained/copied/async contexts, descriptor rejection, no fallback, codec/outer/inherited-head failures before context issuance, foreign/mixed journal bindings, invalid folds, visible-response policy, size/entry ceilings and owner revocation. Existing store/schema-routing/ledger/cancellation/original-run/codec suites remain regression coverage. Saved runner receipts record PID, actual close/exit, source pins and raw log hashes. Root owns integration, final broader validation and repository cleanup.
