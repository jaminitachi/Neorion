Overview abbreviates Project hooks. See area details.

# @formbricks/web architecture (app router)

Start here, then open relevant area links below or browse [all details](neorion/graph/). Detail headings name source areas. Numbered parts continue the same area.
Fact prefixes: rendered (including layout reachability), wrap (outermost first), rename, fetch (static fetch URLs, SWR keys and axios URLs). Conditional wrap lines show possible branches. Search for wrap @ID to expand a shared chain. Unmarked targets render and import. [render], [import] and [action] mark other relationships. UI/icon targets are counted.
Unmarked files use the server default. (c) marks a client boundary, (L) a layout wrapping pages below it, and [*] unknown Pages API methods.
Reverse usage for selected project symbols: [renders](<neorion/graph/+reverse-renders.md>), [hooks](<neorion/graph/+reverse-hooks.md>), [actions](<neorion/graph/+reverse-actions.md>).
Detail budget abbreviates rendered, rename lists. Search source for missing results.
Routes follow the tree. Drop App Router groups and slots, or the Pages filename extension and trailing index. A dot continues the parent route row. Explicit URL overrides follow →.

## Routes

~~~text
app  error.tsx(error)(c)=ErrorBoundary  global-error.tsx(global-error)(c)=GlobalError  layout.tsx(L)=RootLayout  not-found.tsx(not-found)=NotFound  page.tsx=Page
  .well-known/oauth-protected-resource/[[...resource]]  route.ts[GET]
  (app)  error.tsx(error)(c)=ErrorBoundary  layout.tsx(L)=AppLayout
    (onboarding)/organizations/[organizationId]  layout.tsx(L)=WorkspaceOnboardingLayout
      landing  layout.tsx(L)=LandingLayout  page.tsx=Page
      workspaces/new  layout.tsx(L)=OnboardingLayout
        ai  page.tsx=Page
        plan  page.tsx=Page
        survey  page.tsx=Page
        templates  page.tsx=Page
    (survey-editor)/workspaces/[workspaceId]  layout.tsx(L)=SurveyEditorWorkspaceLayout
      creatives/[creativeId]/edit  loading.tsx(loading)=CreativeEditorSkeleton  page.tsx=CreativeEditorPage
      surveys
        [surveyId]/edit  loading.tsx(loading)=SurveyEditorLoading  page.tsx=SurveyEditorPage
        templates  loading.tsx(loading)=SurveyTemplatesLoading  page.tsx=SurveyTemplatesPage
    account
      authorize  page.tsx=Page
      settings  layout.tsx(L)=AccountSettingsLayout
        authorized-apps  page.tsx=Page
        notifications  page.tsx=Page
        profile  page.tsx=Page
    attachment-exports  layout.tsx(L)=AttachmentExportsLayout
      [exportId]  page.tsx=Page
    billing-confirmation  page.tsx=Page
    organizations/[organizationId]
      dashboards-unavailable  page.tsx=Page
      settings  layout.tsx(L)=OrgSettingsLayout  page.tsx=Page
        api-keys  page.tsx=Page
        billing  page.tsx=Page
        data-retention  layout.tsx(L)=Layout  page.tsx=Page
          exemptions  page.tsx=Page
          history  page.tsx=Page
          policies  page.tsx=Page
        domain  page.tsx=Page
        enterprise  page.tsx=Page
        feedback-directories  page.tsx=Page
        general  page.tsx=Page
        teams  page.tsx=Page
        usage  page.tsx=Page
    workspaces  page.tsx=Page
      [workspaceId]  layout.tsx(L)=WorkspaceLayout  page.tsx=WorkspacePage
        (analysis)  layout.tsx(L)=AnalysisLayout  loading.tsx(loading)=AnalysisListLoading
          charts  page.tsx=ChartsPage
          dashboards  page.tsx=DashboardsPage
            [dashboardId]  page.tsx=Page
        (contacts)  layout.tsx(L)=ContactsLayout
          attributes  page.tsx=AttributesPage
          contacts  page.tsx=ContactsPage
            [contactId]  page.tsx=SingleContactPage
          segments  page.tsx=SegmentsPage
        (workspace)/feedback-sources  page.tsx=FeedbackSourcesRedirect
        creatives  layout.tsx(L)=CreativesLayout  loading.tsx(loading)=CreativesListSkeleton  page.tsx=CreativesListPage
          [creativeId]  page.tsx=CreativePage
            summary  loading.tsx(loading)=CreativeSummarySkeleton  page.tsx=CreativeSummaryPage
        settings  layout.tsx(L)=SettingsLayout  page.tsx=Page
          account
            notifications  loading.tsx(loading)(c)=Loading
            profile  loading.tsx(loading)(c)=Loading
          organization
            api-keys  loading.tsx(loading)=LoadingPage
            billing  loading.tsx(loading)=Loading
            enterprise  loading.tsx(loading)=Loading
            general  loading.tsx(loading)=Loading
          workspace  layout.tsx(L)  page.tsx
            (setup)
              app-connection  loading.tsx(loading)=AppConnectionLoading  page.tsx=AppConnectionPage
              user-actions  loading.tsx(loading)=UserActionsLoading  page.tsx=UserActionsPage
            embedded-data  page.tsx=EmbeddedDataSettingsPage
            general  loading.tsx(loading)=GeneralSettingsLoading  page.tsx=GeneralSettingsPage
            integrations  page.tsx=Page  template.tsx(template)=IntegrationsSettingsTemplate
              airtable  page.tsx=Page
              google-sheets  loading.tsx(loading)(c)=Loading  page.tsx=Page
              notion  loading.tsx(loading)(c)=Loading  page.tsx=Page
              slack  page.tsx=Page
              webhooks  page.tsx=WebhooksPage
            languages  loading.tsx(loading)=LanguagesLoading  page.tsx=LanguagesPage
            look  loading.tsx(loading)=WorkspaceLookSettingsLoading  page.tsx=WorkspaceLookSettingsPage
            tags  layout.tsx(L)=TagsSettingsLayout  loading.tsx(loading)=TagsLoading  page.tsx=TagsPage
            teams  page.tsx=WorkspaceTeams
        surveys  layout.tsx(L)=SurveysLayout  loading.tsx(loading)=SurveyListLoading  page.tsx=SurveysPage
          [surveyId]  layout.tsx(L)=SurveyLayout  page.tsx=Page
            (analysis)  layout.tsx(L)=SurveyLayout  loading.tsx(loading)(c)=Loading
              responses  loading.tsx(loading)(c)=Loading  page.tsx=Page
              summary  loading.tsx(loading)(c)=Loading  page.tsx=SurveyPage
        unify  page.tsx=UnifyPage
          feedback-records  page.tsx=UnifyFeedbackRecordsPage
          sources  page.tsx=UnifyFeedbackSourcesPage
          taxonomy  loading.tsx(loading)=Loading  page.tsx=UnifyTopicsSubtopicsPage
        workflows  layout.tsx(L)=WorkflowsLayout
          (list)  layout.tsx(L)=WorkspaceWorkflowsLayout  loading.tsx(loading)=WorkflowsListBodyLoading  page.tsx=WorkflowsPage
            runs  loading.tsx(loading)=WorkspaceWorkflowRunsBodyLoading  page.tsx=WorkflowRunsPage
          [workflowId]/(detail)  layout.tsx(L)=WorkflowDetailLayout  loading.tsx(loading)=WorkflowBuilderBodyLoading  page.tsx=WorkflowPage
            runs  loading.tsx(loading)=WorkflowRunsBodyLoading  page.tsx=WorkflowRuns
  (auth)  layout.tsx(L)=AuthGroupLayout
    auth  layout.tsx(L)=AuthLayout
      account-deleted  page.tsx=AccountDeletedPage
      forgot-password  page.tsx=ForgotPasswordPage
        email-sent  page.tsx=EmailSentPage
        reset  page.tsx=ResetPasswordPage
          success  page.tsx=ResetPasswordSuccessPage
      login  page.tsx=LoginPage
      signup  page.tsx=SignupPage
      signup-without-verification-success  page.tsx=SignupWithoutVerificationSuccessPage
      verification-requested  page.tsx=VerificationRequestedPage
    email-change-without-verification-success  page.tsx=EmailChangeWithoutVerificationSuccessPage
    invite  page.tsx=InvitePage
    verify-email-change  page.tsx=VerifyEmailChangePage
  (redirects)
    environments/[environmentId]  route.ts[GET]
      [...path]  route.ts[GET]
    legacy-organization-settings/[workspaceId]/[[...path]]  route.ts[GET]
    marketing-links/[[...path]]  route.ts[GET]
    organizations/[organizationId]  route.ts[GET]
  api
    (internal)
      envoy-auth/[...path]  route.ts[GET HEAD POST PUT DELETE PATCH OPTIONS]
      organizations/[organizationId]/usage  route.ts[GET]
      surveys/[surveyId]
        attachment-exports  route.ts[POST]
          [exportId]/download  route.ts[GET]
        attachments  route.ts[GET]
        export  route.ts[POST]
      traefik-auth/[...path]  route.ts[GET HEAD POST PUT DELETE PATCH OPTIONS]
      unify-feedback/sources/csv/import  route.ts[POST]
      workspaces/[workspaceId]/integrations/[type]  route.ts[GET]
    auth
      [...all]  route.ts[GET POST]
      saml
        authorize  route.ts[GET]
        callback  route.ts[POST]
        token  route.ts[POST]
        userinfo  route.ts[GET]
      sso/recovery/complete  route.ts[GET]
    billing/stripe-webhook  route.ts[POST]
    google-sheet  route.ts[GET]
      callback  route.ts[GET]
    internal
      charts/generate  route.ts[POST]
      feedback-datasets/[datasetId]/purge  route.ts[POST]
      matrix-questions  route.ts[GET]
      members/[userId]/reactivate  route.ts[POST]
      retention-exemptions  route.ts[GET POST]
        [exemptionId]  route.ts[GET]
          revoke  route.ts[POST]
        survey-options  route.ts[GET]
      retention-health  route.ts[GET]
      retention-policies  route.ts[GET PATCH]
      retention-runs  route.ts[GET]
        export  route.ts[GET]
      survey-retention/[surveyId]  route.ts[GET]
      surveys
        [surveyId]
          content  route.ts[PUT]
          export  route.ts[GET]
        generate/stream  route.ts[POST]
        import/stream  route.ts[POST]
        imports  route.ts[POST]
    mcp  route.ts[POST]
    v1
      client
        [workspaceId]
          displays  route.ts[POST OPTIONS]
            [displayId]/response  route.ts[GET OPTIONS]
          environment  route.ts[GET OPTIONS]
          responses  route.ts[POST OPTIONS]
            [responseId]  route.ts[PUT OPTIONS]
          storage  route.ts[POST OPTIONS]
          user  route.ts[POST OPTIONS]
        og  route.tsx[GET]
      integrations
        airtable  route.ts[GET]
          callback  route.ts[GET]
          tables  route.ts[GET]
        notion  route.ts[GET]
          callback  route.ts[GET]
        slack  route.ts[GET]
          callback  route.ts[GET]
      management
        action-classes  route.ts[GET POST]
          [actionClassId]  route.ts[GET PUT DELETE]
        contact-attribute-keys  route.ts[GET POST]
          [contactAttributeKeyId]  route.ts[GET PUT DELETE]
        contact-attributes  route.ts[GET]
        contacts  route.ts[GET]
          [contactId]  route.ts[GET DELETE]
        me  route.ts[GET]
        responses  route.ts[GET POST]
          [responseId]  route.ts[GET PUT DELETE]
        storage  route.ts[POST]
        surveys  route.ts[GET POST]
          [surveyId]  route.ts[GET PUT DELETE]
            singleUseIds  route.ts[GET]
      webhooks  route.ts[GET POST]
        [webhookId]  route.ts[GET DELETE]
    v2
      client/[workspaceId]
        creatives/events  route.ts[POST OPTIONS]
        displays  route.ts[POST OPTIONS]
        environment  route.ts[GET OPTIONS]
        responses  route.ts[POST OPTIONS]
          [responseId]  route.ts[PUT OPTIONS]
        storage  route.ts[POST OPTIONS]
        user  route.ts[POST OPTIONS]
      health  route.ts[GET]
      management
        contact-attribute-keys  route.ts[GET POST]
          [contactAttributeKeyId]  route.ts[GET PUT DELETE]
        contacts  route.ts[POST]
          bulk  route.ts[PUT]
        responses  route.ts[GET POST]
          [responseId]  route.ts[GET PUT DELETE]
        surveys/[surveyId]/contact-links
          contacts/[contactId]  route.ts[GET]
          segments/[segmentId]  route.ts[GET]
        webhooks  route.ts[GET POST]
          [webhookId]  route.ts[GET PUT DELETE]
      me  route.ts[GET]
      organizations/[organizationId]
        teams  route.ts[GET POST]
          [teamId]  route.ts[GET PUT DELETE]
        users  route.ts[GET POST PATCH]
        workspace-teams  route.ts[GET POST PUT DELETE]
      roles  route.ts[GET]
    v3
      action-classes  route.ts[GET]
      charts  route.ts[GET POST]
        [chartId]  route.ts[GET DELETE PATCH]
          data  route.ts[GET]
          duplicate  route.ts[POST]
        fields  route.ts[GET]
          [field]/values  route.ts[GET]
        preview  route.ts[POST]
      contact-attribute-keys  route.ts[GET]
      contacts  route.ts[GET]
        attribute-values  route.ts[GET]
      creatives  route.ts[GET POST]
        [creativeId]  route.ts[GET DELETE PATCH]
          archive  route.ts[POST]
          duplicate  route.ts[POST]
          restore  route.ts[POST]
          stats  route.ts[GET]
        pause  route.ts[POST]
      dashboards  route.ts[GET POST]
        [dashboardId]  route.ts[GET PUT DELETE PATCH]
          charts/[chartId]/data  route.ts[GET]
          duplicate  route.ts[POST]
          filter-fields  route.ts[GET]
          filters/[filterId]/values  route.ts[GET]
          widgets  route.ts[POST]
            [widgetId]  route.ts[GET DELETE PATCH]
      feedbackRecords
        [[...path]]  route.ts[GET HEAD POST PUT DELETE PATCH OPTIONS]
        token  route.ts[POST]
      gateway/token  route.ts[POST]
      responses  route.ts[GET POST]
        [responseId]  route.ts[GET DELETE PATCH]
        batch-delete  route.ts[POST]
        batch-outcome  route.ts[POST]
        count  route.ts[GET]
        validate  route.ts[POST]
      segments  route.ts[GET]
      surveys  route.ts[GET POST]
        [surveyId]  route.ts[GET DELETE PATCH]
          archive  route.ts[POST]
          blocks  route.ts[PATCH]
            order  route.ts[PUT]
          restore  route.ts[POST]
          visibility  route.ts[GET POST]
        generate  route.ts[POST]
        templates  route.ts[POST]
        validate  route.ts[POST]
      tags  route.ts[GET]
        [tagId]  route.ts[DELETE PATCH]
          merge  route.ts[POST]
      unify-feedback
        enrichment-status  route.ts[GET]
        taxonomy
          fields  route.ts[GET]
          nodes/[nodeId]  route.ts[DELETE PATCH]
            records  route.ts[GET]
          runs  route.ts[POST]
            [runId]  route.ts[GET]
              record-counts  route.ts[GET]
          state  route.ts[GET]
      workflows  route.ts[GET POST]
        [workflowId]  route.ts[GET DELETE PATCH]
          archive  route.ts[POST]
          disable  route.ts[POST]
          duplicate  route.ts[POST]
          enable  route.ts[POST]
          test  route.ts[POST]
          unarchive  route.ts[POST]
        runs  route.ts[GET]
          [runId]  route.ts[GET]
      workspaces/[workspaceId]/custom-css  route.ts[GET PATCH]
  c/[jwt]  error.tsx(error)(c)=LinkSurveyError  page.tsx=ContactSurveyPage
  health  route.ts[GET]
    ready  route.ts[GET]
  p/[slug]  error.tsx(error)(c)=LinkSurveyError  not-found.tsx(not-found)=NotFound  page.tsx=PrettyUrlPage
  s/[surveyId]  error.tsx(error)(c)=LinkSurveyError  layout.tsx(L)=LinkSurveyLayout  not-found.tsx(not-found)=NotFound  page.tsx=LinkSurveyPage
  setup  layout.tsx(L)=SetupLayout  page.tsx=Page
    (fresh-instance)  layout.tsx(L)=FreshInstanceLayout
      intro  page.tsx=IntroPage
      signup  page.tsx=SignupPage
    organization
      [organizationId]/invite  page.tsx=InvitePage
      create  page.tsx=CreateOrganizationPage
  storage/[workspaceId]/[accessType]/[...filePath]  route.ts[GET DELETE]
  v1/feedback-records/[[...path]]  route.ts[GET HEAD POST PUT DELETE PATCH OPTIONS]
~~~

## Server actions

~~~text
modules/auth/invite/page.tsx > modules/auth/invite/page.tsx#InvitePage.createMembershipAction
modules/auth/invite/page.tsx#InvitePage.createMembershipAction
~~~

## Areas

- [modules/ee](<neorion/graph/modules~ee.md>)
- [app/(app)](<neorion/graph/app~(app).md>)
- [modules/ui](<neorion/graph/modules~ui.md>)
- [modules/survey](<neorion/graph/modules~survey.md>)
- [app/api](<neorion/graph/app~api.md>)
- [modules/workspaces](<neorion/graph/modules~workspaces.md>)
- [modules/auth](<neorion/graph/modules~auth.md>)
- [modules/organization](<neorion/graph/modules~organization.md>)
- [modules/analysis](<neorion/graph/modules~analysis.md>)
- [app/(auth)](<neorion/graph/app~(auth).md>)
- [modules/custom-css](<neorion/graph/modules~custom-css.md>)
- [modules/embedded-data](<neorion/graph/modules~embedded-data.md>)
- [modules/integrations](<neorion/graph/modules~integrations.md>)
- [modules/setup](<neorion/graph/modules~setup.md>)
- [app/setup](<neorion/graph/app~setup.md>)
- [modules/settings](<neorion/graph/modules~settings.md>)
- [app](<neorion/graph/app.md>)
- [app/(redirects)](<neorion/graph/app~(redirects).md>)
- [app/s](<neorion/graph/app~s.md>)
- [lib](<neorion/graph/lib.md>)
- [app/p](<neorion/graph/app~p.md>)
- [modules/show-conditions](<neorion/graph/modules~show-conditions.md>)
- [modules/storage](<neorion/graph/modules~storage.md>)
- [app/c](<neorion/graph/app~c.md>)
- [app/health](<neorion/graph/app~health.md>)
- [lib/utils](<neorion/graph/lib~utils.md>)
- [modules/utils](<neorion/graph/modules~utils.md>)
- [playwright](<neorion/graph/playwright.md>)
- [app/.well-known](<neorion/graph/app~.well-known.md>)
- [app/components](<neorion/graph/app~components.md>)
- [app/storage](<neorion/graph/app~storage.md>)
- [app/v1](<neorion/graph/app~v1.md>)
- [lib/sentry](<neorion/graph/lib~sentry.md>)
- [lingodotdev](<neorion/graph/lingodotdev.md>)
- [modules/account](<neorion/graph/modules~account.md>)
- [modules/ai](<neorion/graph/modules~ai.md>)
- [modules/email](<neorion/graph/modules~email.md>)
- [modules/hub](<neorion/graph/modules~hub.md>)
- [playwright/utils](<neorion/graph/playwright~utils.md>)
- [Dependencies](<neorion/graph/+dependencies.md>)

## Project hooks

~~~text
app/(app)/workspaces/[workspaceId]/context/workspace-context.tsx: useWorkspaceContext,useOptionalWorkspaceContext,useWorkspace,useDeploymentInfo,useOrganization
modules/ui/components/table-toolbar/hooks/use-table-url-state.ts: useTableUrlState
modules/ui/hooks/use-before-unload-prompt.ts: useBeforeUnloadPrompt
lib/use-debounced-value.ts: useDebouncedValue
app/(app)/workspaces/[workspaceId]/surveys/[surveyId]/context/survey-context.tsx: useSurvey
modules/ui/components/table-toolbar/hooks/use-table-column-state.ts: useColumnSizing,useTableColumnState
modules/auth/hooks/use-sign-out.ts: useSignOut
modules/custom-css/components/hooks/use-custom-css-validation.ts: useCustomCssValidation
modules/settings/hooks/use-switcher-data.ts: useSwitcherData
modules/survey/components/template-list/hooks/use-create-survey-from-template.ts: useCreateSurveyFromTemplate
modules/survey/link/hooks/use-app-locale.ts: useAppLocale
app/(app)/workspaces/[workspaceId]/settings/workspace/integrations/hooks/use-integration.ts: useIntegration
app/(app)/workspaces/[workspaceId]/surveys/[surveyId]/(analysis)/hooks/use-response-table-filters.ts: useResponseTableFilters
modules/ee/workflows/hooks/use-track-workflow-surface.ts: useTrackWorkflowSurface
modules/ee/workflows/hooks/use-trigger-survey-picker.ts: useWorkflowSurveyOptions,useWorkflowSurveyEndings
modules/ee/workflows/hooks/use-workflow-builder.ts: useWorkflowBuilder
modules/survey/visibility/hooks/use-update-survey-visibility.ts: useUpdateSurveyVisibility
modules/ui/components/styling-appearance/index.tsx: useStylingAppearance
modules/ui/components/table-toolbar/hooks/use-available-values.ts: useAvailableValuesQuery,useAvailableValues,useEmptyHint
modules/ui/components/table-toolbar/hooks/use-value-labels.ts: useLabelledProperty
app/(app)/workspaces/[workspaceId]/surveys/[surveyId]/(analysis)/components/response-filter-context.tsx: useResponseFilter
modules/ee/analysis/charts/hooks/use-charts.ts: useCharts
modules/ee/analysis/dashboards/hooks/use-dashboard-options.ts: useDashboardOptions
modules/ee/creatives/components/creatives-access-provider.tsx: useCreativesAccess
modules/ee/creatives/hooks/use-creative-status-change.ts: useCreativeStatusChange
modules/ee/creatives/hooks/use-creative-status-reason-text.ts: useCreativeStatusReasonText
modules/ee/creatives/hooks/use-survey-linked-creatives.ts: useSurveyLinkedCreatives,useSurveyStatusChangeWithCreatives
modules/ee/data-retention/hooks/use-retention-health.ts: useRetentionHealth
modules/ee/data-retention/hooks/use-retention-policies.ts: useRetentionPolicies,useUpdateRetentionPolicy
modules/ee/workflows/hooks/use-workflow-node-field-focus.ts: useWorkflowNodeFieldFocus
modules/ee/workflows/hooks/use-workflow-runs.ts: useWorkflowRuns
modules/survey/components/template-list/hooks/use-draft-creation.ts: useDraftCreation
modules/survey/editor/components/copy-id-button.tsx: useCopyId
modules/survey/editor/components/reference-chip.tsx: useElementIcons
modules/survey/editor/lib/action-utils.ts: useActionClassKeys
modules/survey/list/hooks/use-survey-removal-mutation.ts: useSurveyRemovalMutation
modules/survey/list/hooks/use-surveys.ts: useSurveys
modules/survey/visibility/hooks/use-visibility-copy.ts: useVisibilityCopy
modules/ui/components/date-time-picker/use-editor-time-zone.ts: useEditorTimeZone
lib/useDocumentVisibility.ts: useDocumentVisibility
lib/utils/hooks/useClickOutside.ts: useClickOutside
modules/analysis/response-outcome/hooks/use-outcome-action.tsx: useOutcomeAction
modules/analysis/response-outcome/hooks/use-set-responses-outcome.ts: useSetResponsesOutcome
modules/custom-css/components/hooks/use-workspace-custom-css.ts: useWorkspaceCustomCssEditor
modules/ee/analysis/charts/hooks/use-chart-dirty-state.ts: useChartDirtyState
modules/ee/analysis/dashboards/hooks/use-chart-data.ts: useChartData
modules/ee/analysis/dashboards/hooks/use-dashboard-embedded-fields.ts: useDashboardEmbeddedFields
modules/ee/analysis/dashboards/hooks/use-dashboard.ts: useDashboard
modules/ee/analysis/dashboards/hooks/use-dashboards.ts: useDashboards
modules/ee/creatives/components/editor/editor-primitives.tsx: useEditorPanels
modules/ee/creatives/hooks/use-creative-editor.ts: useCreativeResource,useCreateCreative,useUpdateCreative
modules/ee/creatives/hooks/use-creative-summary.ts: useCreativeStats
modules/ee/creatives/hooks/use-creative-warning-text.ts: useCreativeWarningText
modules/ee/data-retention/hooks/use-retention-exemptions.ts: useRetentionExemptions,useCreateRetentionExemption,useRevokeRetentionExemption,useRetentionExemptionSurveyOptions
modules/ee/data-retention/hooks/use-retention-runs.ts: useRetentionRuns,useDownloadRetentionExport
modules/ee/data-retention/hooks/use-survey-retention.ts: useSurveyRetention
modules/ee/unify-feedback/enrichment-status/hooks/use-enrichment-status.ts: useEnrichmentStatus
modules/ee/unify-feedback/hooks/use-feedback-records.ts: useFeedbackRecords
modules/ee/unify-feedback/topics-subtopics/hooks/use-remove-taxonomy-node.ts: useRemoveTaxonomyNode
modules/ee/unify-feedback/topics-subtopics/hooks/use-rename-taxonomy-node.ts: useRenameTaxonomyNode
modules/ee/unify-feedback/topics-subtopics/hooks/use-taxonomy-fields.ts: useTaxonomyFields
modules/ee/unify-feedback/topics-subtopics/hooks/use-taxonomy-node-records.ts: useTaxonomyNodeRecords
modules/ee/unify-feedback/topics-subtopics/hooks/use-taxonomy-record-counts.ts: useTaxonomyRecordCounts
modules/ee/unify-feedback/topics-subtopics/hooks/use-taxonomy-run.ts: useTaxonomyRun
modules/ee/unify-feedback/topics-subtopics/hooks/use-taxonomy-state.ts: useTaxonomyState
modules/ee/unify-feedback/topics-subtopics/hooks/use-trigger-taxonomy-run.ts: useTriggerTaxonomyRun
modules/ee/workflows/hooks/use-archive-workflow.ts: useArchiveWorkflow
modules/ee/workflows/hooks/use-create-workflow.ts: useCreateWorkflow
modules/ee/workflows/hooks/use-delete-workflow.ts: useDeleteWorkflow
modules/ee/workflows/hooks/use-duplicate-workflow.ts: useDuplicateWorkflow
~~~
