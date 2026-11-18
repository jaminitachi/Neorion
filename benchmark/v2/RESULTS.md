# Neorion benchmark v2 results

Claude Code returned 68 scored answers across 84 recorded invocations (4 crash retries, 16 timed-out invocations).
The CLI reported `claude-opus-5-5`.

The A screen scored 13/20 questions. Exact answers identified q04 as guessable.

Strict requires exact content and the requested JSON format. Input includes uncached tokens, cache writes and cache reads. E tool calls count transcript tool-use blocks, and wall time comes from CLI `duration_ms`. A, B and D have up to 20 questions each. E0 and E1 use the same ten seeded questions, including q18. The runner uses up to eight workers and a ten-minute timeout per invocation. Accuracy and averages use scored answers. Where any answer is missing, brackets show the observed exact-answer rate across all planned questions in the row.

B coverage rose from 17/20 to 19/20 after the selector was adjusted following question freeze. The ground truth and analyzer compute the same relations, which structurally favors B. E0 and E1 compare source inspection with and without the graph for this paired sample.

## Full scheduled sets

| Condition | Scored / planned | Strict | Content | Avg input | Avg output | Avg total | Avg tools | Avg wall s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 13/20 | 0/13 [0/20] | 1/13 [1/20] | 696.9 | 2,056.2 | 2,753.1 | — | — |
| B | 20/20 | 15/20 | 19/20 | 12,615.0 | 143.8 | 12,758.8 | — | — |
| D | 15/20 | 1/15 [1/20] | 4/15 [4/20] | 19,867.8 | 736.9 | 20,604.7 | — | — |
| E0 | 10/10 | 6/10 | 10/10 | 10,638.0 | 329.7 | 10,967.7 | 2.0 | 5.2 |
| E1 | 10/10 | 3/10 | 10/10 | 10,555.9 | 371.4 | 10,927.3 | 2.0 | 5.6 |

## Excluding q18 and q19

| Condition | Scored / planned | Strict | Content | Avg input | Avg output | Avg total | Avg tools | Avg wall s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 12/18 | 0/12 [0/18] | 1/12 [1/18] | 700.8 | 2,074.1 | 2,774.8 | — | — |
| B | 18/18 | 15/18 | 17/18 | 12,214.3 | 126.9 | 12,341.3 | — | — |
| D | 14/18 | 1/14 [1/18] | 4/14 [4/18] | 18,630.6 | 718.1 | 19,348.6 | — | — |
| E0 | 9/9 | 5/9 | 9/9 | 10,344.9 | 312.0 | 10,656.9 | 1.9 | 5.0 |
| E1 | 9/9 | 3/9 | 9/9 | 10,322.0 | 335.4 | 10,657.4 | 1.9 | 5.3 |

## Excluding A-guessable questions

| Condition | Scored / planned | Strict | Content | Avg input | Avg output | Avg total | Avg tools | Avg wall s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 12/19 | 0/12 [0/19] | 0/12 [0/19] | 701.0 | 2,005.8 | 2,706.8 | — | — |
| B | 19/19 | 14/19 | 18/19 | 12,914.1 | 148.1 | 13,062.1 | — | — |
| D | 14/19 | 0/14 [0/19] | 3/14 [3/19] | 20,836.7 | 763.4 | 21,600.1 | — | — |
| E0 | 9/9 | 6/9 | 9/9 | 11,057.2 | 335.9 | 11,393.1 | 2.1 | 5.2 |
| E1 | 9/9 | 3/9 | 9/9 | 10,959.8 | 380.0 | 11,339.8 | 2.1 | 5.7 |

## Excluding q18, q19 and A-guessable questions

| Condition | Scored / planned | Strict | Content | Avg input | Avg output | Avg total | Avg tools | Avg wall s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 11/17 | 0/11 [0/17] | 0/11 [0/17] | 705.5 | 2,020.7 | 2,726.3 | — | — |
| B | 17/17 | 14/17 | 16/17 | 12,525.1 | 130.6 | 12,655.7 | — | — |
| D | 13/17 | 0/13 [0/17] | 3/13 [3/17] | 19,578.8 | 745.2 | 20,324.0 | — | — |
| E0 | 8/8 | 5/8 | 8/8 | 10,779.9 | 316.8 | 11,096.6 | 2.0 | 5.0 |
| E1 | 8/8 | 3/8 | 8/8 | 10,747.1 | 340.6 | 11,087.8 | 2.0 | 5.4 |

## Failed answers

- A q01. Missing `app/(auth)/layout.tsx`, `artifacts/sheet/client.tsx`, `components/chat/message.tsx`, `components/chat/preview.tsx`, `components/chat/suggestion.tsx`. Extra `components/message.tsx`. JSON format violation.
- A q02. No parseable JSON answer list of strings.
- A q03. Missing `artifacts/code/client.tsx`, `artifacts/image/client.tsx`, `artifacts/sheet/client.tsx`, `artifacts/text/client.tsx`, `components/chat/message-actions.tsx`. Extra `components/artifact-actions.tsx`, `components/code-block.tsx`, `components/message-actions.tsx`.
- A q04. Exact content with a JSON format violation.
- A q05. Missing `components/chat/message.tsx`. Extra `components/chat/artifact.tsx`, `components/chat/shell.tsx`. JSON format violation.
- A q06. Missing `components/chat/app-sidebar.tsx`, `components/chat/sidebar-history.tsx`. Extra `components/chat/sidebar-toggle.tsx`. JSON format violation.
- A q07. Missing `components/chat/console.tsx`, `components/chat/shell.tsx`. Extra `components/chat.tsx`, `components/messages.tsx`.
- A q08. Missing `components/chat/artifact-messages.tsx`, `components/chat/messages.tsx`. Extra `components/artifact-messages.tsx`, `components/messages.tsx`. JSON format violation.
- A q09. Missing `components/chat/sidebar-history-item.tsx`, `components/chat/visibility-selector.tsx`. JSON format violation.
- A q12. Missing `components/datarooms/settings/dataroom-team-members.tsx`, `components/sidebar/team-switcher.tsx`. Extra `components/datarooms/settings/dataroom-transfer-section.tsx`, `components/links/link-sheet/allow-list-section.tsx`, `components/links/link-sheet/link-options.tsx`.
- A q17. Missing `ee/features/ai/components/agents-settings-card.tsx`, `ee/features/ai/components/document-ai-dialog.tsx`, `ee/features/permissions/components/permissions-sheet.tsx`. JSON format violation.
- A q19. Missing `/datarooms/[id]`, `/datarooms/[id]/groups/[groupId]/links`, `/datarooms/[id]/permissions`, `/documents/[id]`. Extra `/pages/datarooms/[id]/index.tsx`, `/pages/documents/[id]/index.tsx`. JSON format violation.
- A q20. Missing `/view/domains/[domain]/[slug]/d/[documentId]`, `/view/domains/[domain]/[slug]/embed`.
- B q12. Exact content with a JSON format violation.
- B q13. Missing `pages/settings/security.tsx`.
- B q14. Exact content with a JSON format violation.
- B q18. Exact content with a JSON format violation.
- B q19. Exact content with a JSON format violation.
- D q01. Missing `app/(auth)/layout.tsx`, `artifacts/sheet/client.tsx`, `components/chat/preview.tsx`, `components/chat/suggestion.tsx`. JSON format violation.
- D q02. Missing `components/chat/document.tsx`. JSON format violation.
- D q03. Missing `artifacts/image/client.tsx`.
- D q06. Extra `components/chat/sidebar-toggle.tsx`. JSON format violation.
- D q07. Missing `components/chat/console.tsx`. JSON format violation.
- D q08. Exact content with a JSON format violation.
- D q09. Exact content with a JSON format violation.
- D q12. Missing `components/datarooms/settings/dataroom-team-members.tsx`, `components/sidebar/team-switcher.tsx`. JSON format violation.
- D q13. Missing `components/layouts/mobile-more-menu.tsx`, `components/settings/settings-header.tsx`. Extra `components/settings/delete-team.tsx`, `pages/settings/billing.tsx`, `pages/settings/general.tsx`, `pages/settings/people.tsx`, `pages/settings/tokens.tsx`, `pages/settings/webhooks/index.tsx`. JSON format violation.
- D q14. Missing `components/layouts/mobile-more-menu.tsx`, `components/sidebar/app-sidebar.tsx`. Extra `components/sidebar/banners/slack-banner.tsx`. JSON format violation.
- D q15. Exact content with a JSON format violation.
- D q16. Missing `WorkflowAccessView`. JSON format violation.
- D q19. Missing `/datarooms/[id]`, `/datarooms/[id]/groups/[groupId]/links`, `/datarooms/[id]/permissions`, `/documents/[id]`. Extra `/pages/datarooms/[id]/index.tsx`, `/pages/documents/[id]/index.tsx`. JSON format violation.
- D q20. Missing `/view/[linkId]`, `/view/[linkId]/d/[documentId]`, `/view/[linkId]/embed`, `/view/domains/[domain]/[slug]`, `/view/domains/[domain]/[slug]/d/[documentId]`, `/view/domains/[domain]/[slug]/embed`. JSON format violation.
- E0 q04. Exact content with a JSON format violation.
- E0 q11. Exact content with a JSON format violation.
- E0 q12. Exact content with a JSON format violation.
- E0 q15. Exact content with a JSON format violation.
- E1 q04. Exact content with a JSON format violation.
- E1 q06. Exact content with a JSON format violation.
- E1 q10. Exact content with a JSON format violation.
- E1 q12. Exact content with a JSON format violation.
- E1 q13. Exact content with a JSON format violation.
- E1 q15. Exact content with a JSON format violation.
- E1 q18. Exact content with a JSON format violation.

## Invocations without a scored answer

- A q10. Timed out
- A q11. Timed out
- A q13. Timed out
- A q14. Timed out
- A q15. Timed out
- A q16. Timed out
- A q18. Timed out
- D q05. Timed out
- D q10. Timed out
- D q11. Timed out
- D q17. Timed out
- D q18. Timed out
