# Real evaluation comparison

- Corpus: repoprep-real-corpus-v1
- Model: deepseek-v4-flash (openai)
- Baseline run: 86f91465-5ac3-4a70-8e5a-9b076bbbf1ab
- Candidate run: 04cc5679-1e4b-4fb5-a724-1e7fe9ff1548
- Source hash changes: 38
- Baseline report SHA-256: 3279159288ace996a57d8012f6eff6752b21c62866854945dbc41294058639e0
- Candidate report SHA-256: 7c45ca6dbf9d9095fbce2a32d73547aee59203398ea8943c81b1ec256e3f4f2c

| Metric | Baseline | Candidate |
|---|---:|---:|
| Questions | 80 | 80 |
| Requests | 4 | 4 |
| Elapsed ms (scan + generation) | 576124 | 560995 |
| Generator phase ms | unknown | 560838 |
| Actual input tokens | 146247 | 66604 |
| Actual output tokens | 114186 | 103843 |
| Estimated input tokens | unknown | 104423 |
| Format repair requests | 0 | 0 |
| Compensation requests | unknown | 0 |
| Context build ms | unknown | 934 |
| Model ms | unknown | 559582 |
| Keyword coverage (hits / facts) | 27 | 25 |

## Cases

| Case | Baseline questions / requests / ms | Candidate questions / requests / ms | Baseline keyword hits | Candidate keyword hits |
|---|---:|---:|---:|---:|
| mitt | 20 / 1 / 161892 | 20 / 1 / 148181 | 6/6 | 6/6 |
| p-limit | 20 / 1 / 133990 | 20 / 1 / 167408 | 7/7 | 7/7 |
| requests | 20 / 1 / 136258 | 20 / 1 / 147388 | 7/8 | 5/8 |
| schedule | 20 / 1 / 143984 | 20 / 1 / 98018 | 7/7 | 7/7 |

## Token and context conditions

| Setting | Baseline | Candidate |
|---|---:|---:|
| contextWindowTokens | unknown | unknown |
| profileMaxOutputTokens | unknown | unknown |
| maxOutputTokens | unknown | unknown |
| maxOutputTokensPolicy | provider-default | provider-default |
| applicationInputTokenTarget | unknown | 32000 |
| applicationInputTokenBudget | unknown | 32000 |
| reservedOutputTokens | unknown | 65536 |
| reservedOutputPolicy | unknown | deepseek-reasoning-reserve-65536 |
| inputTokenBudgetPolicy | unknown | min(application target, max(0, configured context window - output reserve)); unknown window uses application target |
| contextStrategy | unknown | structure-v1 |
| tokenEstimateMethod | unknown | mixed-text-v1 |

## Source hash changes

| File | Baseline SHA-256 | Candidate SHA-256 |
|---|---|---|
| electron/services/context-budget-integration.test.ts | 146ff20ad334536a1f192e77304782b877664b6adf3855d1bb9bf51ba04ead27 | f3341c07b07f787e55ae8e701af1571cfa03728ce809d51f274e59dacc5bd07d |
| electron/services/context-builder.ts | 169f86e92e0b47aa11fd83fb851512d77b757bb9a5470bbaa786aae84dde2052 | 843bf919d08678b25021be43c63d259e2d530035115bf5555d8eba7043815167 |
| electron/services/context-selection.test.ts | b75aed7a60d7838f2b50a354e9363bc25712c3799a4151032e728654322ee4c4 | 6f03651448ac17f90b13e0fe40b5ff782d17fed0cae84e2dcf02961a60434343 |
| electron/services/file-selection.ts | ebe5c3747a1144731591e98922d6150a330b171e428bd2b1bb0e60ff0a4d6c52 | c23785a5e42dafaa4ac80e3b8a949f576f90a305f05121c989b085b0f6a5fa99 |
| electron/services/generator-grounding.test.ts | absent | 6a03cb8ab82873d571edb8a1128128808c2d0b51267164e82be81dc95c48cbb3 |
| electron/services/generator-merge.test.ts | 9668b6975c135e1dba967240f6d4abe261eb8698cf6c5559837458470ceff762 | 26c07ac081d55aa030a1213806fc3b903b023a271ee56bd4e21ee15700cf9684 |
| electron/services/generator.ts | 5124a42eb31e755744597e911a71d7a826702b5d8001fad9f8efece119a91d4e | c1e5818b0b241cd59a86a5f3385a136d2621e7393e12dd3dfd9a3c25910b78ac |
| electron/services/ipc-handler-guards.test.ts | 02bad40e3f96c4041a98a01c8b4e2b6556721941cff8bf99e8ecad500448ee68 | 263a78eff5dda13c0d2cec4ea59a6487e622da84c6bd3ac12147dd2c2cc1f88f |
| electron/services/ipc-handler-guards.ts | 9a4b79942171cb0e7c9b03e3e6e6e0de1dba1566e4dccd134b57de95d7b198f2 | f6e3452d1d99f88ec4cc7d91b2caa8ec3b63a4862293b2d97552e2ce33f9128f |
| electron/services/ipc-validation.test.ts | cd987b06ea9b39fe3fdb3f538e14bd259f42c222996bbc579321e97e54281136 | c03aa8d95c4c70f6ed9d6adef29aec79de7e212af25e54de62171dcb30f2f4b3 |
| electron/services/ipc-validation.ts | 1027a421f805a2c698d06cf5288cbc77bdb45b8300d56af3733bb45645ecf961 | f4a4f38ca50b5bb7e1647ce135da16316b8e6aa3bc0d2243cc36393bf984b2de |
| electron/services/llm-anthropic.test.ts | 3915bec379e6a4899f37e4de2b022231209cea441d604866fb869c9d35c63ad1 | 5078c635aea30377317a7509248e03380fde1650da8550ba3420f0901e0b60ab |
| electron/services/llm-safe-results.test.ts | 98361e9de2fb101b9a9e3ee64b544107fe4dc5c1c510bc5ad2e49128c9aa5b4a | 6c1abe292e56bbbcd5a4d5dc2e5818f33fa5f5d575c5b15d7d859c9a21c11938 |
| electron/services/llm.ts | c2f582b370dc59222063d58234d2f7f8405e07acbcf6d6ddbd5768f630f1e4fb | b6aab97202ec221162101d69af5f4ef5d127d2eeb7ae51e40b1feb7f22671c92 |
| electron/services/markdown-export.ts | 75d499fc77adc77252df816fa2d288512167fda4661a591aef8eb953aec2063c | 63262c0710a328babf2330ce894dd0100f1739303590a63f403a9313b8303253 |
| electron/services/result-store-contract.test.ts | 17ff7e670c87d458df1f6a462af873e1163e05596ed859a7d48e6b6e53b38638 | 4e370015f0944be80e79ce63b68039eac09f75e5a25a92d7b85fa57cb2ccabfd |
| electron/services/snippet-selection-integration.test.ts | absent | e8431428577eb3e061788e158bdad1985b27972d7badddc13cf89ef4f76bc843 |
| electron/services/snippet-selection.test.ts | absent | b305056ad83183fcf48bf437af6ac2d35385fb561f629d7f233ba5884fb37003 |
| electron/services/snippet-selection.ts | absent | c67203342c740eb121a1613cc87f7319495c495f200cce68478c9bf3cd11ee50 |
| electron/services/source-analysis.test.ts | absent | a1af0f084389b1ca630699d423e28460ebfd9e1c02f4d41f0b586a56714c5591 |
| electron/services/source-analysis.ts | absent | 0f30b5952e9f781c8e2b31554f6f0e03eded8cff58f7f246eee532727ab1e192 |
| electron/services/storage-recovery.test.ts | 624ca7da17eefc39fad32f0a7732ce4168999a8cbee13bdc2a02e36c17b17b29 | 301057f8921fe05fd7d3afdcb6c64c342ca6c1092f7e94965006a59467c60b5a |
| electron/services/store.ts | 9452e07c43c67257ed2cbdeb2cf993081c5f0c29fcbad9e964f8ba7a35666fd2 | 9ca358200c58f8728ab34c490c1150befd8649779c4a61839c97a597d8e0d804 |
| package-lock.json | 9c193be42b519d84da85c14e96fff01e33facddef152921c58f002af21c20feb | fe075856ff56d808fb3a144d8f51f22faae1936c5267ea751882d61b2d11d75e |
| package.json | 9f9c16ec44f45cda224b8ee9e1ea915854918ca4a23fe378e41743131ed48060 | afcf751730063750d4d57605cc3b6b0ef3c382446799322d6010db239544f9fc |
| scripts/evaluation/compare-real-runs.mjs | absent | 842727fba5f1744fe6a3508005ce844c4914c50766282b270e433ad9eb0f68b8 |
| scripts/evaluation/compare-real-runs.test.mjs | absent | 213137a0204a96084305681f3d251976bee743a9dceb73cb3f33158810422e49 |
| scripts/evaluation/real-runner.mjs | 2ade07f06394b19ff1b4e2450281754792e32f90b539104a2cd06aa20725eec7 | c4313b809494441bdc7a976251a3eb6aaf320b401914401faff040860d8b01f9 |
| scripts/evaluation/real-runner.test.mjs | fca55938550e182365c7ab5eb01c8903ad15c2870ec75b0bc69b83c5b8ff42a1 | 70baa71081b4b2105c60eebad5b596c7bbc0eeebd25c6d75a346424c8914e8db |
| scripts/evaluation/run-saved-profile-entry.cjs | f85ea3a4dfc246c5151404baf418a8e5e1faee1f55d22eb1578cf45be11dc9b7 | 09acbf03cd9ea37c24831d90afccd2811f42c71fa25afc9e07d08ffd9d252927 |
| scripts/evaluation/run-saved-profile.cjs | 6a9e716c1d333ca5e3463c8053e2f8971b0d9e9b9d9887462ca7d2e6823766f3 | 6faf1316609d811fcfe93ce740e46474a58cbe2ebd133695436c5835ab32f8c3 |
| scripts/evaluation/run-saved-profile.test.cjs | 5141afab8edeff2c2868b22e4ae57634d626b74ede7ce9097cd1bb7cb117387f | 9d28b0805d63fb6c912ab0c8fa71ae184c6d832a96d2fab1c06cc3fc2923202c |
| scripts/evaluation/variant-arguments.cjs | absent | 11119a8af013b0f7f12292352f180d7057f4657955419c0e024bb49dd6ce14e2 |
| shared/result-contract.test.ts | dc9b452355349ef719c5bb6c8159d29fe825a3a9cd3b8582b6118f8882beaa5f | 05ef666a349e81cc9499df53eb3ece2f96c1f2d9a4f728d0521cce073865758e |
| shared/result-contract.ts | be132b3a93ee14415de69273b2fc81ff01228acdf40e747c4482e5bf5c61e71d | 4f0df8d91080f2d703e35a66b4b606a5e7aaebb46a3a7a27255fa6ded5613609 |
| shared/token-budget.test.ts | absent | 5a48d8f50a89150ffdfff51c53a673c023dcf70909c400bf2eef593324d4ae13 |
| shared/token-budget.ts | absent | 6e7609e55b8a9e0641afdf22b5e9bfd1f7884afe7292c0775a05b38291c3b138 |
| shared/types.ts | 5d6481606d3c8ba0696f2c579ab8a9c9141d719e480e373434a561ae0cdc07f1 | 296ca0030fe2651d91b8062476d62861a3d268c608b1a284ca1a6ae4b56df79f |

## Limitations

- Actual provider token totals are null when complete usage receipts are unavailable.
- Estimated input tokens are application estimates and are reported separately from provider usage.
- Keyword fact coverage counts configured keyword matches; it is not factual accuracy.
- This comparison does not treat assistant review as human review.
- The legacy report digest does not bind generation metadata; the comparator checks canonical output and question cross-links and records hashes of both complete input reports.
