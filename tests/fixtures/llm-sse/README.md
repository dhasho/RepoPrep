# LLM SSE parser fixtures

These small fixtures are protocol-derived examples for framing and consumer tests. They are not recordings from a real account, live endpoint, or named service provider. The OpenAI-style example follows the public Chat Completions streaming example and event schema; the compatible multi-line sample exercises the generic SSE framing rule that multiple `data:` fields join with a newline.

- [WHATWG EventSource parsing](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)
- [OpenAI Chat Completions create reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- `openai-chat.sse`: role delta, text deltas, stop reason, usage-only chunk with `choices: []`, and `[DONE]`.
- `compatible-multiline.sse`: JSON split across `data:` fields, containing Chinese text and an emoji.
- `finish-stop-tail.sse`: final content and stop reason with no terminating newline, for the finite-stream `finish()` compatibility extension.
- `error-event.sse`: named error event containing an explicitly fictitious credential-shaped string.
- `interrupted.sse`: partial content without a finish reason or `[DONE]` marker.
