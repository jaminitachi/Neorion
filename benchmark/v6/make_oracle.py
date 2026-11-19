#!/usr/bin/env python3
"""Write oracle.jsonl: independent ground truth (TypeScript compiler API, gen/) plus the hand check for each task.
No Neorion code or output is used. Usage: python3 make_oracle.py"""
import json

MANUAL = {
 "v6-dub-01": ("CountryCombobox is rendered only at ui/modals/add-customer-modal.tsx:410 inside AddCustomerModal. AddCustomerModal is rendered at ui/customers/customer-selector.tsx:82 (the useAddCustomerModal hook at add-customer-modal.tsx:516 has no importer). CustomerSelector is rendered only by app/app.dub.co/(dashboard)/[slug]/(ee)/links/customers/[customerId]/layout.tsx:69. That layout wraps one page, .../[customerId]/sales/page.tsx.",
               ["the only route is reached through a layout, not a page", "a modal two levels down"]),
 "v6-dub-02": ("LineItem is rendered by BarList (bar-list.tsx:224) and VirtualLineItem (bar-list.tsx:533, same file, used by BarList). BarList is rendered by device-section, location-section, referrers-utms, top-links (all under StatsGrid in ui/analytics/index.tsx) and by settings/billing/usage-chart.tsx:573. The default Analytics of ui/analytics/index.tsx is rendered by links/analytics/page.tsx:12 and (share)/share/[dashboardId]/page.tsx:103. UsageChart is rendered by billing/plan-usage.tsx:367, rendered by billing/page.tsx:10. ui/placeholders/features-section.tsx renders a different Analytics (feature-graphics/analytics). links/events/page.tsx imports AnalyticsClient, not Analytics.",
               ["generic name LineItem", "a same-named Analytics component in placeholders", "route group (share)"]),
 "v6-dub-03": ("Three direct renderers: link-title-column.tsx:390 (Details, inside LinkTitleColumn), link-builder/link-creator-info.tsx:15, settings/tokens/page.tsx:125. LinkTitleColumn <- link-card.tsx:137 LinkCardInner <- LinkCard <- links-container.tsx:120 LinksList <- LinksContainer <- links/page-client.tsx:266 WorkspaceLinksList <- WorkspaceLinksClient <- links/page.tsx. LinkCreatorInfo <- links/[...link]/page-client.tsx:233,253 <- LinkPageClient <- links/[...link]/page.tsx. share-dashboard-modal.tsx:366 declares a different local LinkCard.",
               ["9-step chain", "catch-all route [...link]", "same-name local LinkCard in share-dashboard-modal.tsx"]),
 "v6-dub-04": ("Layouts on the path: app/layout.tsx (wraps children in RootProviders, app/providers.tsx, whose own wrappers are @dub/ui and third-party), app/app.dub.co/layout.tsx (SessionProvider, Suspense: third-party), app/app.dub.co/(onboarding)/layout.tsx (fragment; SignedInHint and Toolbar are siblings, not ancestors).",
               ["siblings SignedInHint and Toolbar must be excluded", "route group (onboarding)"]),
 "v6-dub-05": ("app/layout.tsx > RootProviders (app/providers.tsx) > app/app.dub.co/layout.tsx > (dashboard)/layout.tsx > ModalProvider (ui/modals/modal-provider.tsx, children inside ModalProviderClient in the same file) > MainNav (ui/layout/main-nav.tsx:122 children) > [slug]/layout.tsx > WorkspaceAuth ([slug]/auth.tsx, returns children) > (ee)/settings/webhooks/layout.tsx > PageContent (ui/layout/page-content/index.tsx:35) > PageWidthWrapper (ui/layout/page-width-wrapper.tsx). UpgradeBanner, Toolbar, modals inside ModalProviderClient, Sidebar and CreateWebhookButton are beside the content. webhooks/[webhookId]/layout.tsx does not apply to /new.",
               ["11 files across 5 layouts", "many sibling components", "a nested [webhookId] layout that does not apply"]),
 "v6-dub-06": ("Word grep for useOnboardingProgress gives the same 9 files as the language service rename: the declaring hook file and 8 importers under app/app.dub.co/(onboarding)/onboarding/.",
               ["easy: no alias, barrel or grep trap"]),
 "v6-dub-07": ("Declared at lib/api/links/create-link.ts:25 and re-exported by `export * from \"./create-link\"` in lib/api/links/index.ts, which a rename does not edit. Seven importers use `@/lib/api/links`: cron/import/csv/route.ts, api/domains/route.ts, api/links/route.ts, api/links/upsert/route.ts, claim-dot-link-domain.ts, finalize-premium-domain-registration.ts, slack/commands.ts. lib/openapi/links/create-link.ts and lib/openapi/links/index.ts use a different createLink (an OpenAPI operation object).",
               ["star re-export barrel", "same-name OpenAPI object (grep false positives)"]),
 "v6-dub-08": ("Only request site: lib/swr/use-usage-timeseries.ts:87 useSWR(`/api/workspaces/${workspaceId}/billing/usage?...`) in the exported useUsageTimeseries. Importers: billing/plan-usage.tsx:9 (UsageTabCard), billing/usage-chart.tsx:6 (UsageChart). No test mentions.",
               ["query-string URL", "sibling billing routes share the prefix"]),
 "v6-dub-09": ("Request sites: ui/webhooks/webhook-trigger-selector.tsx:90 (SWR key in WebhookTriggerSelector), lib/integrations/common/ui/configure-webhook.tsx:102 (mutate in ConfigureWebhook), ui/webhooks/add-edit-webhook-form.tsx:118 (mutate in AddEditWebhookForm). One-level references: ConfigureWebhook <- segment, slack, zapier ui/settings.tsx; AddEditWebhookForm <- webhooks/new/page-client.tsx, webhooks/[webhookId]/edit/page-client.tsx; WebhookTriggerSelector <- configure-webhook.tsx and add-edit-webhook-form.tsx (already counted). `/api/folders?workspaceId=` in ui/folders and modals is a different route.",
               ["three request functions", "integration settings pages under lib/", "prefix-sharing /api/folders route"]),
 "v6-dub-10": ("lib/webhook/signature.ts:2 createWebhookSignature (crypto.subtle HMAC SHA-256). Its only caller is lib/webhook/qstash.ts:90, which sets the \"Dub-Signature\" header at qstash.ts:101. qstash.ts exports one value, sendWebhooks, referenced by lib/webhook/publish.ts:4, lib/actions/send-test-webhook.ts:6, app/(ee)/api/cron/streams/send-link-clicked-webhooks/route.ts:9, and the excluded test tests/webhooks/index.test.ts:3. Other HMAC code (shopify webhook route, slack verify-request, email unsubscribe-token) is out of scope by the question.",
               ["concept search: the question names no file or symbol", "other HMAC code for incoming webhooks"]),
 "v6-dub-11": ("Text search for VERCEL_API_KEY in code files gives 7 files, all `process.env.VERCEL_API_KEY` in an Authorization header (remove-domain-vercel.ts twice). .env.example is excluded by the question. The AST scan (property access, element access, destructuring) and the text search agree.",
               ["control: env reads are not graph edges"]),
}

tasks = [json.loads(l) for l in open("tasks.jsonl", encoding="utf-8") if l.strip()]
assert set(MANUAL) == {t["id"] for t in tasks}
with open("oracle.jsonl", "w", encoding="utf-8") as f:
    for t in tasks:
        note, traps = MANUAL[t["id"]]
        f.write(json.dumps({
            "id": t["id"], "type": t["type"], "difficulty": t["difficulty"], "subject": t["subject"],
            "answer_kind": t["answer_kind"], "answer": t["answer"],
            "source": "independent: TypeScript 5.6.3 compiler API (gen/), no Neorion code or output",
            "manual_verification": note, "traps": traps, "verified_by_hand": True,
        }, ensure_ascii=False) + "\n")
print(len(tasks), "oracle rows")
