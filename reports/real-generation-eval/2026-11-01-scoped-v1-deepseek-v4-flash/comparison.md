# Real evaluation comparison

- Corpus: repoprep-real-corpus-v1
- Model: deepseek-v4-flash (openai)
- Baseline run: ee69a921-05fe-4d8d-bf44-2ba4bc72ee21
- Candidate run: c87cf61f-cacd-4e5f-821f-be1471372856
- Source hash changes: 38
- Baseline report SHA-256: b43f6285748390fa108b66bdc781e93229b27d56be6cf896300886dfb7243c0e
- Candidate report SHA-256: b02f6db5b04d7ab346372373b657d4900e2092196027d71f1fbc66efb4c6865a

| Metric | Baseline | Candidate |
|---|---:|---:|
| Questions | 80 | 80 |
| Requests | 4 | 4 |
| Elapsed ms (scan + generation) | 557201 | 772491 |
| Generator phase ms | 557105 | 772352 |
| Actual input tokens | 109577 | 109986 |
| Actual output tokens | 103959 | 144853 |
| Estimated input tokens | 168526 | 169307 |
| Format repair requests | 0 | 0 |
| Compensation requests | 0 | 0 |
| Context build ms | 727 | 1081 |
| Model ms | 555980 | 770622 |
| Keyword coverage (hits / facts) | 27 | 28 |

## Cases

| Case | Baseline questions / requests / ms | Candidate questions / requests / ms | Baseline keyword hits | Candidate keyword hits |
|---|---:|---:|---:|---:|
| mitt | 20 / 1 / 179983 | 20 / 1 / 260689 | 6/6 | 6/6 |
| p-limit | 20 / 1 / 121986 | 20 / 1 / 201616 | 7/7 | 7/7 |
| requests | 20 / 1 / 93818 | 20 / 1 / 191815 | 7/8 | 8/8 |
| schedule | 20 / 1 / 161414 | 20 / 1 / 118371 | 7/7 | 7/7 |

## Token and context conditions

| Setting | Baseline | Candidate |
|---|---:|---:|
| contextWindowTokens | unknown | 1000000 |
| profileMaxOutputTokens | unknown | unknown |
| maxOutputTokens | unknown | unknown |
| maxOutputTokensPolicy | provider-default | provider-default |
| applicationInputTokenTarget | 64000 | 64000 |
| applicationInputTokenBudget | 64000 | 64000 |
| reservedOutputTokens | 65536 | 65536 |
| reservedOutputPolicy | deepseek-reasoning-reserve-65536 | deepseek-reasoning-reserve-65536 |
| inputTokenBudgetPolicy | min(application target, max(0, configured context window - output reserve)); unknown window uses application target | min(application target, max(0, configured context window - output reserve)); unknown window uses application target |
| contextStrategy | structure-v1 | structure-v1 |
| tokenEstimateMethod | mixed-text-v1 | mixed-text-v1 |

## Source hash changes

| File | Baseline SHA-256 | Candidate SHA-256 |
|---|---|---|
| electron/services/context-builder.ts | 3b52015502b965708b5b22a2f90fe676a1917d8e71a7b85ace879de0fbc6eb99 | cd1ba774aeadf82f65f5506e68e129823a84435fea3833f9d9c78b4d34634358 |
| electron/services/generation-checkpoint.test.ts | absent | 0e25ba8d6dffa1b96ea7f65b39ea906ee8098b3ac1b0df1cd64add0f7218f032 |
| electron/services/generation-draft-store.test.ts | absent | b5c56fc88bfc177377e39da44f287452190b8e425b6ff6dd83e17861106ad7af |
| electron/services/generation-draft-store.ts | absent | 484d98fdcc57ca1e1798a51a0511d8f480cfcf3fb588fbb0d6f7fa8b8485ef18 |
| electron/services/generation-drafts.ts | absent | 8eb17e99c184e4b29151f4a4fcb2574989ee26fc09c6c63ae1fccec10d9943ee |
| electron/services/generation-preview.test.ts | absent | b0510459b76e02a76abe6290dc625bb3d038c7eb1bb95a583fb9268222275f85 |
| electron/services/generation-streaming.test.ts | absent | f7cd30f9cdc7b1087aafd6fd5172a4d286976460918a156303ff47f3ef494045 |
| electron/services/generator-grounding.test.ts | 6a03cb8ab82873d571edb8a1128128808c2d0b51267164e82be81dc95c48cbb3 | 89c68d4bf0669f730cfe62a6b85c8339290f59934b43d7dad7f88a0a394901cc |
| electron/services/generator-merge.test.ts | 26c07ac081d55aa030a1213806fc3b903b023a271ee56bd4e21ee15700cf9684 | 19f8ca2cdb479ca600c4273e5648f1eb98fb24139570693bc252696102762ec9 |
| electron/services/generator.ts | 9072e8736d3edca5fce917f67774ca84c1c9193a6b299d44565cefad6a06614a | 98f7650dbf123a580a8b1ac7d3ef59fd1bd44619136c014e7a55dcd204b19207 |
| electron/services/interview-json-stream.test.ts | absent | 1e2cf85cc2d8a57ec542fb26efbff55439caa54494734364831127886b915481 |
| electron/services/interview-json-stream.ts | absent | 333e8f6799ac8b03d289d6e5439e021204b8622a12371bae0a9269656a2fa294 |
| electron/services/ipc-handler-guards.test.ts | 263a78eff5dda13c0d2cec4ea59a6487e622da84c6bd3ac12147dd2c2cc1f88f | 24eb034cfa296cbc30432b12d8567abbf14a35a64c81b690c0185f216883a503 |
| electron/services/ipc-handler-guards.ts | f6e3452d1d99f88ec4cc7d91b2caa8ec3b63a4862293b2d97552e2ce33f9128f | 69c8db7322441b8883f2c38b46076d785c71b83375f5216ecad1faa5889d4ce2 |
| electron/services/ipc-validation.test.ts | c03aa8d95c4c70f6ed9d6adef29aec79de7e212af25e54de62171dcb30f2f4b3 | 95835717fcb2bcd08f112c59a93ad99eef1eec4bac31dd0b342836efb0c8d0ba |
| electron/services/ipc-validation.ts | f4a4f38ca50b5bb7e1647ce135da16316b8e6aa3bc0d2243cc36393bf984b2de | 2a2490aa4c189f8323b3e0df8ef08ba42c8f5c5443c3a7ac3c8058cfe343ed7d |
| electron/services/llm-anthropic.test.ts | 5078c635aea30377317a7509248e03380fde1650da8550ba3420f0901e0b60ab | 6bce16249a0438d02602610582c13c298c49528c1cb6680ec387febb23ac219a |
| electron/services/llm-streaming.test.ts | 1ca3a339b73f54293b7df618a126a171c17575a0dcba223cbf2ea6350b7923b5 | 636b317e1cfd5cb22f03555f06568577acd088747b793153c3cde074d14cebfa |
| electron/services/llm.ts | b6aab97202ec221162101d69af5f4ef5d127d2eeb7ae51e40b1feb7f22671c92 | 05900b0cd76730459572f68dd4cc220d0d1c888c8ec9bcb76683bf2d93a8854a |
| electron/services/markdown-export.ts | 63262c0710a328babf2330ce894dd0100f1739303590a63f403a9313b8303253 | e50f2e223177d9f3e761c070bf2049aed946d857beb78080c9a2f7e5d1b367a7 |
| electron/services/question-budget-integration.test.ts | ac114f484d72558ac8efe6b7ac2ce099d5c6dd8ab8a212512fc4d4b8299160b6 | 51c38c33fdd218bc9c4a3e2faf1f87ede6f90d19ce745614cf6ff20a44f35d3f |
| electron/services/recent-relocation.test.ts | cd071e5f56a1145ebc607c824a93d55d2bec368cbff224fc287c9e8d1428f573 | 32c03bfe36efd28c88c49ccd03d2d30cf8957e292c464b50af7206796d5824a4 |
| electron/services/result-store-contract.test.ts | 4e370015f0944be80e79ce63b68039eac09f75e5a25a92d7b85fa57cb2ccabfd | 57d2bce984cfe6be3c2e57d80a8bce9fd6bacecbb8456fc27aa48232b9151228 |
| electron/services/snippet-selection.test.ts | 27a56ddf83431e132670cf670306aeeb656020aad3a07f1da6cd67098911069d | 178a1f3277c45d4faefe6e0cbf10a9aa34a84c97ef4fb5b8bbad850c9c627903 |
| electron/services/snippet-selection.ts | 12e387b25b5dabf9a327f6552b99b5f502a070c2302275e05dd23306c1e5a48c | b7d72395f4d9f8c1756c29aa0ee06f1d9b31c5414c553c6a98edfcda16f37152 |
| package-lock.json | fe075856ff56d808fb3a144d8f51f22faae1936c5267ea751882d61b2d11d75e | 353190be39ebe27401d8c7d7f6796963641f2b5fc455ce5f31fbf9422b93dee4 |
| package.json | 8b844578f329ccf9957cd60d797a96b4ead0299d2c622367c80072fd60132525 | 951d24480002817451ca55f66ac8fc4569b48957b3090234137a9af9778c0f4b |
| scripts/evaluation/real-runner.mjs | c4313b809494441bdc7a976251a3eb6aaf320b401914401faff040860d8b01f9 | 61540c2b38077e5e244c88f7103c448c3e7be9851ff52ccaea46a4cf61402ee8 |
| scripts/evaluation/real-runner.test.mjs | 70baa71081b4b2105c60eebad5b596c7bbc0eeebd25c6d75a346424c8914e8db | f43d92cfc933bac30725bc3e6e361867ebcee8e4a7060aa2c0f6265cbeac2870 |
| shared/answer-markdown.test.ts | absent | afc872d9c4fc8c2f7bd4609e1b356c0d15bbcb53066afcaf565676d7b5ec4a2d |
| shared/answer-markdown.ts | absent | 225af577a256741941d3272c3e7d4b3e042d7c5a6c73586250a969246b01177c |
| shared/generation-checkpoint.ts | absent | 9e1437013a35a2548cf4285f89f9d8cd0c09df415fc0b6c97649477fbc52d07d |
| shared/generation-preview.test.ts | absent | 748533caa2e91eb4ac16b9d4c9e7ae4e2edb2756afae1b24b373160732c92e83 |
| shared/generation-preview.ts | absent | 2e4c4bb860b95176c3222ed9bc55b740d90f15f3a4a6116a3ee43d8f65a6ecc7 |
| shared/ipc.ts | 951a706d78a991364a9d278efdaf3e5b9d5cf92103158e1ec72c655dd9adc847 | 67c600fe55ccb59e51abfd0247c9a3672d3446e4f17aeb8412f105b757d5c742 |
| shared/result-contract.test.ts | 05ef666a349e81cc9499df53eb3ece2f96c1f2d9a4f728d0521cce073865758e | 3bc86746c37da9eaada778f6a6a048fbfe61fda8e573593c0b301b1e2eb5534a |
| shared/result-contract.ts | 4f0df8d91080f2d703e35a66b4b606a5e7aaebb46a3a7a27255fa6ded5613609 | 4939cef594e3f4b4919ae59a1ad981b63219cb915e79147a1f9fdbf523191619 |
| shared/types.ts | 296ca0030fe2651d91b8062476d62861a3d268c608b1a284ca1a6ae4b56df79f | 70f8bdf5bbd96558ac880c457342296e773af6d1b2da5a69614e5c28d860b2e5 |

## Limitations

- Actual provider token totals are null when complete usage receipts are unavailable.
- Estimated input tokens are application estimates and are reported separately from provider usage.
- Keyword fact coverage counts configured keyword matches; it is not factual accuracy.
- This comparison does not treat assistant review as human review.
- The legacy report digest does not bind generation metadata; the comparator checks canonical output and question cross-links and records hashes of both complete input reports.
