# Source evidence

Generated questions may include bounded source evidence resolved by the main process from the exact model request that produced the question. Source files are redacted before clipping, then rendered with one-based line numbers. Each request has its own source ID allowlist; retries and batches cannot borrow IDs from another request.

The model returns only `{ sourceId, startLine, endLine }`. The main process ignores model-supplied paths or excerpts and stores the canonical relative path, the SHA-256 hash of the redacted file content actually sent, the requested line range, and the corresponding redacted excerpt. A request-truncated final partial line is not citable. Unknown IDs, unsafe paths, invalid or reversed ranges, ranges over 30 lines, and excerpts over 3,000 characters are rejected. Each question keeps at most three references and a generation keeps at most 100,000 excerpt characters.

`sourceEvidenceSummary.asked`, `accepted`, and `rejected` count references normalized from valid model question objects across all model replies. `retained` counts references that remain attached after deduplication, quota trimming, and the total excerpt budget. Old version-1 history without evidence remains valid.

The hash identifies the sanitized transmitted snapshot and makes it possible to distinguish snapshots. It is not an identity proof. A valid range confirms that the excerpt was available to the model; it does not establish that the excerpt semantically supports the answer or that the answer is factually correct. Those claims still need human or evaluation review.
