# Real evaluation comparison

- Corpus: repoprep-real-corpus-v1
- Model: deepseek-v4-flash (openai)
- Baseline run: 314d1677-7aee-4e7a-a56e-2000fadcc21c
- Candidate run: 0a84cfe5-0b30-41e0-8ff7-4e30328f9d02
- Source hash changes: 10
- Baseline report SHA-256: 5050a2cc9509ee36beee91a9be71166dd97660cee839f139202ebe29c487c415
- Candidate report SHA-256: fad3d0e27a47caaedaaa5623558492a26b723c5fcb9680456dbb47867b206efe

| Metric | Baseline | Candidate |
|---|---:|---:|
| Questions | 20 | 20 |
| Requests | 1 | 1 |
| Elapsed ms (scan + generation) | 219279 | 112336 |
| Generator phase ms | 219193 | 112262 |
| Actual input tokens | 42209 | 42465 |
| Actual output tokens | 42768 | 20812 |
| Estimated input tokens | 63934 | 63878 |
| Format repair requests | 0 | 0 |
| Compensation requests | 0 | 0 |
| Context build ms | 807 | 729 |
| Model ms | 218096 | 111335 |
| Keyword coverage (hits / facts) | 7 | 7 |

## Cases

| Case | Baseline questions / requests / ms | Candidate questions / requests / ms | Baseline keyword hits | Candidate keyword hits |
|---|---:|---:|---:|---:|
| requests | 20 / 1 / 219279 | 20 / 1 / 112336 | 7/8 | 7/8 |

## Token and context conditions

| Setting | Baseline | Candidate |
|---|---:|---:|
| reasoningEffort | low | low |
| contextWindowTokens | 1000000 | 1000000 |
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
| electron/services/context-budget-integration.test.ts | 1e277075641be48285c23f61d10b03150396bf0fd9ac7d5bf045ae2f787c35b8 | cd04e36f35ca777367601d3a20eaddf4daf01c296e14c34ea870d39607f6af1d |
| electron/services/context-builder.ts | e2cf926d53338b63732d888d85ae6b4701fae1438a49a05f89353e44a583b661 | 533a362738a3e64bbf9c08c2ceef615f43d1d48ee03ffb94fffd1415d65e96ca |
| electron/services/generator.ts | b4ac20ca89d41d30bb85c36eae0f33ffbf333c65eb81bb88eeecb3de17ae647f | a1bff062d1e86f178c9f061349627a44245d088ce6bb14e54b1f1f6894361204 |
| electron/services/snippet-selection-integration.test.ts | 0943f3103a137353a42bea78cb165c6af0b3b855c641fdcf4689732c469473bb | be78e50df27b8d01a354c61810859bb53ba8eac530b47f465a622dc0cb3e5910 |
| electron/services/snippet-selection.test.ts | 1d1e2ccb56b5d06259719ef83e94dd2add9449378cc18945efcec8435af41976 | dd241807157334194e4cfea0e5ae263b437f96954eda6ca144a82e7853607739 |
| electron/services/snippet-selection.ts | 51d2f1bf66b5a6714d94e1809405f5abacf9189dffe1273cc03a1bbc51a5002b | c2c8c7586c47fe180c55e9c5ed3c35867902ce94af375273d837da80eb77f7d9 |
| package.json | 951d24480002817451ca55f66ac8fc4569b48957b3090234137a9af9778c0f4b | 8c591f1c427d4e51a68ae86bd83573f65bf4900f8fc10987fc3ab373286eca87 |
| scripts/evaluation/context-audit.mjs | absent | 3364162c2d948e9d7a4350c763fe4230ce9afafda4e1c021e892d13cd91720cb |
| scripts/evaluation/context-audit.test.mjs | absent | ba27ce7cb5d1070989c4917c392308e35d11ada89ee512e053324f9ce860a07a |
| scripts/evaluation/real-runner.mjs | 75afaccbf425d57c866619862bd3c8738e455dc68b5a5b50c4078b8853dcbbf0 | 57cbb560eaf6e82b4c2c7bf1408f8d05469696ce8023e3a9aba3097290205a15 |

## Limitations

- Actual provider token totals are null when complete usage receipts are unavailable.
- Estimated input tokens are application estimates and are reported separately from provider usage.
- Keyword fact coverage counts configured keyword matches; it is not factual accuracy.
- This comparison does not treat assistant review as human review.
- The legacy report digest does not bind generation metadata; the comparator checks canonical output and question cross-links and records hashes of both complete input reports.
