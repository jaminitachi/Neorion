# Codebase Architecture Map

```xml
<codebase name="neo_client" framework="nextjs" router="app" language="ts">
  <directories>
    <dir path="app" role="routes" />
    <dir path="components" role="ui_components" />
    <dir path="hooks" role="react_hooks" />
    <dir path="lib" role="utils" />
  </directories>

  <routes>
    <route id="route__layout" path="/" file="layout.tsx" type="layout" segment="." isClient="false" />
    <route id="route__page" path="/" file="page.tsx" type="page" segment="." isClient="false" />
    <route id="route_admin_layout" path="/admin" file="admin/layout.tsx" type="layout" segment="admin" isClient="false" />
    <route id="route_admin_page" path="/admin" file="admin/page.tsx" type="page" segment="admin" isClient="false" />
    <route id="route_create_layout" path="/create" file="create/layout.tsx" type="layout" segment="create" isClient="false" />
    <route id="route_create_loading" path="/create" file="create/loading.tsx" type="loading" segment="create" isClient="false" />
    <route id="route_create_page" path="/create" file="create/page.tsx" type="page" segment="create" isClient="true" />
    <route id="route_dashboard_page" path="/dashboard" file="dashboard/page.tsx" type="page" segment="dashboard" isClient="false" />
    <route id="route_library_page" path="/library" file="library/page.tsx" type="page" segment="library" isClient="true" />
    <route id="route_mypage_page" path="/mypage" file="mypage/page.tsx" type="page" segment="mypage" isClient="false" />
    <route id="route_notice_page" path="/notice" file="notice/page.tsx" type="page" segment="notice" isClient="false" />
    <route id="route_sentry-example-page_page" path="/sentry-example-page" file="sentry-example-page/page.tsx" type="page" segment="sentry-example-page" isClient="true" />
    <route id="route_store_page" path="/store" file="store/page.tsx" type="page" segment="store" isClient="false" />
    <route id="route_support_page" path="/support" file="support/page.tsx" type="page" segment="support" isClient="true" />
    <route id="route_terms_layout" path="/terms" file="terms/layout.tsx" type="layout" segment="terms" isClient="false" />
    <route id="route_verify-age_page" path="/verify-age" file="verify-age/page.tsx" type="page" segment="verify-age" isClient="true" />
    <route id="route_auth_find_page" path="/find" file="(auth)/find/page.tsx" type="page" segment="find" isClient="false" />
    <route id="route_auth_login_page" path="/login" file="(auth)/login/page.tsx" type="page" segment="login" isClient="false" />
    <route id="route_auth_signup_page" path="/signup" file="(auth)/signup/page.tsx" type="page" segment="signup" isClient="false" />
    <route id="route_admin_novels_page" path="/admin/novels" file="admin/novels/page.tsx" type="page" segment="novels" isClient="false" />
    <route id="route_admin_stats_page" path="/admin/stats" file="admin/stats/page.tsx" type="page" segment="stats" isClient="true" />
    <route id="route_admin_support_page" path="/admin/support" file="admin/support/page.tsx" type="page" segment="support" isClient="false" />
    <route id="route_admin_users_page" path="/admin/users" file="admin/users/page.tsx" type="page" segment="users" isClient="false" />
    <route id="route_genre_[genre]_layout" path="/genre/[genre]" file="genre/[genre]/layout.tsx" type="layout" segment="[genre]" isClient="false" />
    <route id="route_genre_[genre]_page" path="/genre/[genre]" file="genre/[genre]/page.tsx" type="page" segment="[genre]" isClient="false" />
    <route id="route_mypage_history_page" path="/mypage/history" file="mypage/history/page.tsx" type="page" segment="history" isClient="false" />
    <route id="route_search_[keyword]_page" path="/search/[keyword]" file="search/[keyword]/page.tsx" type="page" segment="[keyword]" isClient="true" />
    <route id="route_terms_copyright_page" path="/terms/copyright" file="terms/copyright/page.tsx" type="page" segment="copyright" isClient="false" />
    <route id="route_terms_privacy_page" path="/terms/privacy" file="terms/privacy/page.tsx" type="page" segment="privacy" isClient="false" />
    <route id="route_terms_service_page" path="/terms/service" file="terms/service/page.tsx" type="page" segment="service" isClient="false" />
    <route id="route_auth_account_setting_page" path="/setting" file="(auth)/(account)/setting/page.tsx" type="page" segment="setting" isClient="false" />
    <route id="route_auth_auth_setting_page" path="/auth/setting" file="(auth)/auth/setting/page.tsx" type="page" segment="setting" isClient="true" />
    <route id="route_auth_auth_update-password_page" path="/auth/update-password" file="(auth)/auth/update-password/page.tsx" type="page" segment="update-password" isClient="true" />
    <route id="route_auth_find_email_page" path="/find/email" file="(auth)/find/email/page.tsx" type="page" segment="email" isClient="true" />
    <route id="route_auth_find_password_page" path="/find/password" file="(auth)/find/password/page.tsx" type="page" segment="password" isClient="true" />
    <route id="route_novel_[id]_chat_loading" path="/novel/[id]/chat" file="novel/[id]/chat/loading.tsx" type="loading" segment="chat" isClient="false" />
    <route id="route_novel_[id]_chat_page" path="/novel/[id]/chat" file="novel/[id]/chat/page.tsx" type="page" segment="chat" isClient="true" />
    <route id="route_auth_account_setting_withdraw_page" path="/setting/withdraw" file="(auth)/(account)/setting/withdraw/page.tsx" type="page" segment="withdraw" isClient="true" />
    <route id="route_auth_find_password_sent_page" path="/find/password/sent" file="(auth)/find/password/sent/page.tsx" type="page" segment="sent" isClient="true" />
  </routes>

  <components>
    <component id="cmp_TermsOfServiceAgreement" name="TermsOfServiceAgreement" path="/home/jaminitachi/neo/neo_client/components/agreements.tsx" kind="ui" isClient="false">
      <imports>
        <import name="Link" from="next/link" />
      </imports>
    </component>
    <component id="cmp_CopyrightTerm" name="CopyrightTerm" path="/home/jaminitachi/neo/neo_client/components/agreements.tsx" kind="ui" isClient="false">
      <imports>
        <import name="Link" from="next/link" />
      </imports>
    </component>
    <component id="cmp_MarketingAgreement" name="MarketingAgreement" path="/home/jaminitachi/neo/neo_client/components/agreements.tsx" kind="ui" isClient="false">
      <imports>
        <import name="Link" from="next/link" />
      </imports>
    </component>
    <component id="cmp_PrivacyPolicyAgreement" name="PrivacyPolicyAgreement" path="/home/jaminitachi/neo/neo_client/components/agreements.tsx" kind="ui" isClient="false">
      <imports>
        <import name="Link" from="next/link" />
      </imports>
    </component>
    <component id="cmp_ErrorFallback" name="ErrorFallback" path="/home/jaminitachi/neo/neo_client/components/common/errorFallback.tsx" kind="ui" isClient="true">
      <imports>
        <import name="Button" from="@/components/ui/button" />
      </imports>
    </component>
    <component id="cmp_Spinner" name="Spinner" path="/home/jaminitachi/neo/neo_client/components/common/GlobalLoadingIndicator.tsx" kind="ui" isClient="true">
      <imports>
        <import name="useLoading" from="@/contexts/LoadingContext" />
        <import name="React" from="react" />
      </imports>
    </component>
    <component id="cmp_GlobalLoadingIndicator" name="GlobalLoadingIndicator" path="/home/jaminitachi/neo/neo_client/components/common/GlobalLoadingIndicator.tsx" kind="ui" isClient="true">
      <imports>
        <import name="useLoading" from="@/contexts/LoadingContext" />
        <import name="React" from="react" />
      </imports>
      <usesHooks>
        <hook name="useLoading" />
        <hook name="useState" />
        <hook name="useEffect" />
      </usesHooks>
    </component>
    <component id="cmp_LoginPromptModal" name="LoginPromptModal" path="/home/jaminitachi/neo/neo_client/components/common/LoginPromptModal.tsx" kind="ui" isClient="true">
      <imports>
        <import name="useRouter" from="next/navigation" />
        <import name="Dialog, DialogContent, DialogDescription, DialogTitle" from="@/components/ui/dialog" />
        <import name="Button" from="@/components/ui/button" />
        <import name="Gift" from="lucide-react" />
      </imports>
      <usesHooks>
        <hook name="useRouter" />
      </usesHooks>
    </component>
    <component id="cmp_NovelDetailModal" name="NovelDetailModal" path="/home/jaminitachi/neo/neo_client/components/common/NovelDetailModal.tsx" kind="ui" isClient="true">
      <imports>
        <import name="useEffect, useState, useRef, useLayoutEffect" from="react" />
        <import name="z" from="zod" />
        <import name="useQuery" from="@tanstack/react-query" />
        <import name="Image" from="next/image" />
        <import name="useRouter" from="next/navigation" />
        <import name="Dialog, DialogContent, DialogTitle, DialogDescription" from="@/components/ui/dialog" />
        <import name="VisuallyHidden" from="@radix-ui/react-visually-hidden" />
        <import name="Button" from="@/components/ui/button" />
        <import name="getNovelDetail" from="@/app/_api/novel.server" />
        <import name="BookOpen, Users" from="lucide-react" />
        <import name="useNovelModal" from="@/hooks/useNovelModal" />
        <import name="useAuth, useAuthLoading" from="@/utils/supabase/authProvider" />
        <import name="LoginPromptModal" from="@/components/common/LoginPromptModal" />
      </imports>
      <usesHooks>
        <hook name="useNovelModal" />
        <hook name="useAuth" />
        <hook name="useAuthLoading" />
        <hook name="useRouter" />
        <hook name="useState" />
        <hook name="useRef" />
        <hook name="useQuery" />
        <hook name="useEffect" />
        <hook name="useLayoutEffect" />
      </usesHooks>
    </component>
    <component id="cmp_QueryProvider" name="QueryProvider" path="/home/jaminitachi/neo/neo_client/components/common/queryProvider.tsx" kind="ui" isClient="true">
      <imports>
        <import name="isServer, QueryClient, QueryClientProvider" from="@tanstack/react-query" />
      </imports>
    </component>
    <component id="cmp_ResponsiveWrapper" name="ResponsiveWrapper" path="/home/jaminitachi/neo/neo_client/components/common/responsiveWrapper.tsx" kind="ui" isClient="true">
      <imports>
        <import name="cn" from="@/lib/utils" />
        <import name="usePathname" from="next/navigation" />
        <import name="NavBarDesktop" from="../layout/navbar" />
        <import name="NavBarFloating, NavBarGradient, NavBarApple, NavBarMaterial, NavBarFloatingMaterial" from="../layout/navbar-designs" />
      </imports>
      <usesHooks>
        <hook name="usePathname" />
      </usesHooks>
    </component>
    <component id="cmp_SuspenseBoundary" name="SuspenseBoundary" path="/home/jaminitachi/neo/neo_client/components/common/suspenseBoundary.tsx" kind="ui" isClient="true">
      <imports>
        <import name="NotFound" from="@/app/not-found" />
        <import name="SuspenseSpinner" from="@/components/ui/spinner" />
        <import name="React" from="react" />
        <import name="ErrorBoundary" from="react-error-boundary" />
      </imports>
    </component>
    <component id="cmp_TokenBadge" name="TokenBadge" path="/home/jaminitachi/neo/neo_client/components/common/tokenBadge.tsx" kind="ui" isClient="true">
      <imports>
        <import name="useUser" from="@/utils/supabase/authProvider" />
        <import name="getUserToken" from="@/utils/supabase/service/token.server" />
        <import name="useQuery" from="@tanstack/react-query" />
        <import name="Image" from="next/image" />
        <import name="useRouter" from="next/navigation" />
        <import name="Plus" from="lucide-react" />
      </imports>
      <usesHooks>
        <hook name="useUser" />
        <hook name="useRouter" />
      </usesHooks>
    </component>
    <component id="cmp_Token" name="Token" path="/home/jaminitachi/neo/neo_client/components/common/tokenBadge.tsx" kind="ui" isClient="true">
      <imports>
        <import name="useUser" from="@/utils/supabase/authProvider" />
        <import name="getUserToken" from="@/utils/supabase/service/token.server" />
        <import name="useQuery" from="@tanstack/react-query" />
        <import name="Image" from="next/image" />
        <import name="useRouter" from="next/navigation" />
        <import name="Plus" from="lucide-react" />
      </imports>
      <usesHooks>
        <hook name="useRouter" />
        <hook name="useQuery" />
      </usesHooks>
    </component>
    <component id="cmp_TokenInsufficientModal" name="TokenInsufficientModal" path="/home/jaminitachi/neo/neo_client/components/common/TokenInsufficientModal.tsx" kind="ui" isClient="true">
      <imports>
        <import name="useRouter" from="next/navigation" />
        <import name="Dialog, DialogContent, DialogDescription, DialogTitle" from="@/components/ui/dialog" />
        <import name="Button" from="@/components/ui/button" />
        <import name="Coins, Sparkles, Star" from="lucide-react" />
      </imports>
      <usesHooks>
        <hook name="useRouter" />
      </usesHooks>
    </component>
    <component id="cmp_Footer" name="Footer" path="/home/jaminitachi/neo/neo_client/components/layout/Footer.tsx" kind="ui" isClient="false">
      <imports>
        <import name="React" from="react" />
        <import name="Link" from="next/link" />
      </imports>
    </component>
    <component id="cmp_FloatingNavItem" name="FloatingNavItem" path="/home/jaminitachi/neo/neo_client/components/layout/navbar-designs.tsx" kind="ui" isClient="true">
      <imports>
        <import name="cn" from="@/lib/utils" />
        <import name="FC, forwardRef, SVGProps" from="react" />
        <import name="Link" from="next/link" />
        <import name="usePathname" from="next/navigation" />
        <import name="useScrollDirection" from="@/hooks/use-scroll-direction" />
        <import name="motion" from="motion/react" />
        <import name="PencilLine, Plus" from="lucide-react" />
        <import name="BoxFilled, HomeFilled, UserFilled, BoxLine, HomeLine, UserLine" from="@/public/navbar" />
      </imports>
    </component>
    <component id="cmp_GradientNavItem" name="GradientNavItem" path="/home/jaminitachi/neo/neo_client/components/layout/navbar-designs.tsx" kind="ui" isClient="true">
      <imports>
        <import name="cn" from="@/lib/utils" />
        <import name="FC, forwardRef, SVGProps" from="react" />
        <import name="Link" from="next/link" />
        <import name="usePathname" from="next/navigation" />
        <import name="useScrollDirection" from="@/hooks/use-scroll-direction" />
        <import name="motion" from="motion/react" />
        <import name="PencilLine, Plus" from="lucide-react" />
        <import name="BoxFilled, HomeFilled, UserFilled, BoxLine, HomeLine, UserLine" from="@/public/navbar" />
      </imports>
    </component>
    <component id="cmp_AppleNavItem" name="AppleNavItem" path="/home/jaminitachi/neo/neo_client/components/layout/navbar-designs.tsx" kind="ui" isClient="true">
      <imports>
        <import name="cn" from="@/lib/utils" />
        <import name="FC, forwardRef, SVGProps" from="react" />
        <import name="Link" from="next/link" />
        <import name="usePathname" from="next/navigation" />
        <import name="useScrollDirection" from="@/hooks/use-scroll-direction" />
        <import name="motion" from="motion/react" />
        <import name="PencilLine, Plus" from="lucide-react" />
        <import name="BoxFilled, HomeFilled, UserFilled, BoxLine, HomeLine, UserLine" from="@/public/navbar" />
      </imports>
    </component>
    <component id="cmp_MaterialNavItem" name="MaterialNavItem" path="/home/jaminitachi/neo/neo_client/components/layout/navbar-designs.tsx" kind="ui" isClient="true">
      <imports>
        <import name="cn" from="@/lib/utils" />
        <import name="FC, forwardRef, SVGProps" from="react" />
        <import name="Link" from="next/link" />
        <import name="usePathname" from="next/navigation" />
        <import name="useScrollDirection" from="@/hooks/use-scroll-direction" />
        <import name="motion" from="motion/react" />
        <import name="PencilLine, Plus" from="lucide-react" />
        <import name="BoxFilled, HomeFilled, UserFilled, BoxLine, HomeLine, UserLine" from="@/public/navbar" />
      </imports>
    </component>
    <component id="cmp_FloatingMaterialNavItem" name="FloatingMaterialNavItem" path="/home/jaminitachi/neo/neo_client/components/layout/navbar-designs.tsx" kind="ui" isClient="true">
      <imports>
        <import name="cn" from="@/lib/utils" />
        <import name="FC, forwardRef, SVGProps" from="react" />
        <import name="Link" from="next/link" />
        <import name="usePathname" from="next/navigation" />
        <import name="useScrollDirection" from="@/hooks/use-scroll-direction" />
        <import name="motion" from="motion/react" />
        <import name="PencilLine, Plus" from="lucide-react" />
        <import name="BoxFilled, HomeFilled, UserFilled, BoxLine, HomeLine, UserLine" from="@/public/navbar" />
      </imports>
    </component>
    <component id="cmp_NavItem" name="NavItem" path="/home/jaminitachi/neo/neo_client/components/layout/navbar.tsx" kind="ui" isClient="true">
      <imports>
        <import name="cn" from="@/lib/utils" />
        <import name="FC, forwardRef, SVGProps" from="react" />
        <import name="BoxFilled, HomeFilled, UserFilled, BoxLine, HomeLine, UserLine" from="@/public/navbar" />
        <import name="Link" from="next/link" />
        <import name="usePathname" from="next/navigation" />
        <import name="motion" from="motion/react" />
        <import name="Image" from="next/image" />
        <import name="PencilLine, Plus" from="lucide-react" />
        <import name="useScrollDirection" from="@/hooks/use-scroll-direction" />
      </imports>
    </component>
    <component id="cmp_SideBar" name="SideBar" path="/home/jaminitachi/neo/neo_client/components/layout/sidebar.tsx" kind="ui" isClient="true">
      <imports>
        <import name="React" from="react" />
        <import name="Image" from="next/image" />
        <import name="Link" from="next/link" />
        <import name="usePathname" from="next/navigation" />
        <import name="X, Loader2" from="lucide-react" />
      </imports>
      <usesHooks>
        <hook name="useState" />
        <hook name="useTransition" />
        <hook name="usePathname" />
        <hook name="useEffect" />
      </usesHooks>
    </component>
    <component id="cmp_AccountForm" name="AccountForm" path="/home/jaminitachi/neo/neo_client/components/signup/accountForm.tsx" kind="ui" isClient="true">
      <imports>
        <import name="SignupFormFieldName" from="@/app/(auth)/signup/schema" />
        <import name="SignupFormField" from="@/app/(auth)/signup/signupFormField" />
        <import name="Button" from="@/components/ui/button" />
        <import name="useValidation" from="@/components/ui/form" />
        <import name="usePageContext" from="@/components/ui/pageContext" />
        <import name="ChevronRight" from="lucide-react" />
        <import name="useFormContext" from="react-hook-form" />
      </imports>
      <usesHooks>
        <hook name="useFormContext" />
        <hook name="usePageContext" />
        <hook name="useValidation" />
      </usesHooks>
    </component>
    <component id="cmp_Badge" name="Badge" path="/home/jaminitachi/neo/neo_client/components/ui/badge.tsx" kind="ui" isClient="false">
      <imports>
        <import name="" from="react" />
        <import name="cva, VariantProps" from="class-variance-authority" />
        <import name="cn" from="@/lib/utils" />
      </imports>
    </component>
    <component id="cmp_BreadcrumbSeparator" name="BreadcrumbSeparator" path="/home/jaminitachi/neo/neo_client/components/ui/breadcrumb.tsx" kind="ui" isClient="false">
      <imports>
        <import name="" from="react" />
        <import name="Slot" from="@radix-ui/react-slot" />
        <import name="ChevronRight, MoreHorizontal" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
      </imports>
    </component>
    <component id="cmp_BreadcrumbEllipsis" name="BreadcrumbEllipsis" path="/home/jaminitachi/neo/neo_client/components/ui/breadcrumb.tsx" kind="ui" isClient="false">
      <imports>
        <import name="" from="react" />
        <import name="Slot" from="@radix-ui/react-slot" />
        <import name="ChevronRight, MoreHorizontal" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
      </imports>
    </component>
    <component id="cmp_MainContent" name="MainContent" path="/home/jaminitachi/neo/neo_client/components/ui/content.tsx" kind="ui" isClient="false">
      <imports>
        <import name="twMerge" from="tailwind-merge" />
      </imports>
    </component>
    <component id="cmp_DialogHeader" name="DialogHeader" path="/home/jaminitachi/neo/neo_client/components/ui/dialog.tsx" kind="ui" isClient="true">
      <imports>
        <import name="" from="react" />
        <import name="" from="@radix-ui/react-dialog" />
        <import name="X" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
      </imports>
    </component>
    <component id="cmp_DialogFooter" name="DialogFooter" path="/home/jaminitachi/neo/neo_client/components/ui/dialog.tsx" kind="ui" isClient="true">
      <imports>
        <import name="" from="react" />
        <import name="" from="@radix-ui/react-dialog" />
        <import name="X" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
      </imports>
    </component>
    <component id="cmp_DropdownMenuShortcut" name="DropdownMenuShortcut" path="/home/jaminitachi/neo/neo_client/components/ui/dropdown-menu.tsx" kind="ui" isClient="true">
      <imports>
        <import name="" from="react" />
        <import name="" from="@radix-ui/react-dropdown-menu" />
        <import name="Check, ChevronRight, Circle" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
      </imports>
    </component>
    <component id="cmp_InputFormField" name="InputFormField" path="/home/jaminitachi/neo/neo_client/components/ui/form.tsx" kind="ui" isClient="true">
      <imports>
        <import name="" from="react" />
        <import name="" from="@radix-ui/react-label" />
        <import name="Slot" from="@radix-ui/react-slot" />
        <import name="Control, Controller, ControllerProps, FieldPath, FieldValues, FormProvider, useFormContext" from="react-hook-form" />
        <import name="cn" from="@/lib/utils" />
        <import name="Label" from="@/components/ui/label" />
        <import name="Input" from="@/components/ui/input" />
        <import name="cva" from="class-variance-authority" />
      </imports>
    </component>
    <component id="cmp_FormField" name="FormField" path="/home/jaminitachi/neo/neo_client/components/ui/form.tsx" kind="ui" isClient="true">
      <imports>
        <import name="" from="react" />
        <import name="" from="@radix-ui/react-label" />
        <import name="Slot" from="@radix-ui/react-slot" />
        <import name="Control, Controller, ControllerProps, FieldPath, FieldValues, FormProvider, useFormContext" from="react-hook-form" />
        <import name="cn" from="@/lib/utils" />
        <import name="Label" from="@/components/ui/label" />
        <import name="Input" from="@/components/ui/input" />
        <import name="cva" from="class-variance-authority" />
      </imports>
    </component>
    <component id="cmp_Header" name="Header" path="/home/jaminitachi/neo/neo_client/components/ui/header.tsx" kind="ui" isClient="false">
      <imports>
        <import name="PrevPageButton" from="@/components/ui/PrevPageButton" />
        <import name="cn" from="@/lib/utils" />
        <import name="HtmlHTMLAttributes" from="react" />
      </imports>
    </component>
    <component id="cmp_Modal" name="Modal" path="/home/jaminitachi/neo/neo_client/components/ui/modal.tsx" kind="ui" isClient="false">
      <imports>
        <import name="Button" from="@/components/ui/button" />
        <import name="Spinner" from="@/components/ui/spinner" />
        <import name="React" from="react" />
      </imports>
    </component>
    <component id="cmp_LoadingModal" name="LoadingModal" path="/home/jaminitachi/neo/neo_client/components/ui/modal.tsx" kind="ui" isClient="false">
      <imports>
        <import name="Button" from="@/components/ui/button" />
        <import name="Spinner" from="@/components/ui/spinner" />
        <import name="React" from="react" />
      </imports>
    </component>
    <component id="cmp_NotificationBell" name="NotificationBell" path="/home/jaminitachi/neo/neo_client/components/ui/notification.tsx" kind="ui" isClient="false">
      <imports>
        <import name="" from="react" />
        <import name="Bell" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
        <import name="DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger" from="@/components/ui/dropdown-menu" />
        <import name="ScrollArea" from="@/components/layout/scroll-area" />
        <import name="Link" from="next/link" />
      </imports>
    </component>
    <component id="cmp_PageProvider" name="PageProvider" path="/home/jaminitachi/neo/neo_client/components/ui/pageContext.tsx" kind="ui" isClient="true">
      <imports>
        <import name="useRouter" from="next/navigation" />
        <import name="React" from="react" />
      </imports>
      <usesHooks>
        <hook name="useState" />
        <hook name="useRouter" />
      </usesHooks>
    </component>
    <component id="cmp_Pagination" name="Pagination" path="/home/jaminitachi/neo/neo_client/components/ui/pagination.tsx" kind="ui" isClient="false">
      <imports>
        <import name="" from="react" />
        <import name="ChevronLeft, ChevronRight, MoreHorizontal" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
        <import name="ButtonProps, buttonVariants" from="@/components/ui/button" />
      </imports>
    </component>
    <component id="cmp_PaginationLink" name="PaginationLink" path="/home/jaminitachi/neo/neo_client/components/ui/pagination.tsx" kind="ui" isClient="false">
      <imports>
        <import name="" from="react" />
        <import name="ChevronLeft, ChevronRight, MoreHorizontal" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
        <import name="ButtonProps, buttonVariants" from="@/components/ui/button" />
      </imports>
    </component>
    <component id="cmp_PaginationPrevious" name="PaginationPrevious" path="/home/jaminitachi/neo/neo_client/components/ui/pagination.tsx" kind="ui" isClient="false">
      <imports>
        <import name="" from="react" />
        <import name="ChevronLeft, ChevronRight, MoreHorizontal" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
        <import name="ButtonProps, buttonVariants" from="@/components/ui/button" />
      </imports>
    </component>
    <component id="cmp_PaginationNext" name="PaginationNext" path="/home/jaminitachi/neo/neo_client/components/ui/pagination.tsx" kind="ui" isClient="false">
      <imports>
        <import name="" from="react" />
        <import name="ChevronLeft, ChevronRight, MoreHorizontal" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
        <import name="ButtonProps, buttonVariants" from="@/components/ui/button" />
      </imports>
    </component>
    <component id="cmp_PaginationEllipsis" name="PaginationEllipsis" path="/home/jaminitachi/neo/neo_client/components/ui/pagination.tsx" kind="ui" isClient="false">
      <imports>
        <import name="" from="react" />
        <import name="ChevronLeft, ChevronRight, MoreHorizontal" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
        <import name="ButtonProps, buttonVariants" from="@/components/ui/button" />
      </imports>
    </component>
    <component id="cmp_SheetHeader" name="SheetHeader" path="/home/jaminitachi/neo/neo_client/components/ui/sheet.tsx" kind="ui" isClient="true">
      <imports>
        <import name="" from="react" />
        <import name="" from="@radix-ui/react-dialog" />
        <import name="cva, VariantProps" from="class-variance-authority" />
        <import name="Menu" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
      </imports>
    </component>
    <component id="cmp_SheetFooter" name="SheetFooter" path="/home/jaminitachi/neo/neo_client/components/ui/sheet.tsx" kind="ui" isClient="true">
      <imports>
        <import name="" from="react" />
        <import name="" from="@radix-ui/react-dialog" />
        <import name="cva, VariantProps" from="class-variance-authority" />
        <import name="Menu" from="lucide-react" />
        <import name="cn" from="@/lib/utils" />
      </imports>
    </component>
    <component id="cmp_Skeleton" name="Skeleton" path="/home/jaminitachi/neo/neo_client/components/ui/skeleton.tsx" kind="ui" isClient="false">
      <imports>
        <import name="cn" from="@/lib/utils" />
      </imports>
    </component>
    <component id="cmp_SocialLoginButton" name="SocialLoginButton" path="/home/jaminitachi/neo/neo_client/components/ui/socialLoginButton.tsx" kind="ui" isClient="true">
      <imports>
        <import name="Button" from="@/components/ui/button" />
        <import name="signInWithOAuth" from="@/utils/supabase/client" />
        <import name="Image" from="next/image" />
      </imports>
    </component>
    <component id="cmp_Spinner" name="Spinner" path="/home/jaminitachi/neo/neo_client/components/ui/spinner.tsx" kind="ui" isClient="false" />
    <component id="cmp_SuspenseSpinner" name="SuspenseSpinner" path="/home/jaminitachi/neo/neo_client/components/ui/spinner.tsx" kind="ui" isClient="false" />
    <component id="cmp_Toaster" name="Toaster" path="/home/jaminitachi/neo/neo_client/components/ui/toaster.tsx" kind="ui" isClient="true">
      <imports>
        <import name="useToast" from="@/hooks/use-toast" />
        <import name="Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport" from="@/components/ui/toast" />
      </imports>
      <usesHooks>
        <hook name="useToast" />
      </usesHooks>
    </component>
    <component id="cmp_UndoButton" name="UndoButton" path="/home/jaminitachi/neo/neo_client/components/ui/undobutton.tsx" kind="ui" isClient="false">
      <imports>
        <import name="Button" from="@/components/ui/button" />
        <import name="ArrowLeft" from="lucide-react" />
      </imports>
    </component>
  </components>

  <hooks>

  </hooks>

  <dependencies>
    <lib name="@floating-ui/react" version="^0.27.13" role="dependency" />
    <lib name="@hookform/resolvers" version="^3.10.0" role="dependency" />
    <lib name="@radix-ui/react-accordion" version="^1.2.8" role="dependency" />
    <lib name="@radix-ui/react-avatar" version="^1.1.2" role="dependency" />
    <lib name="@radix-ui/react-checkbox" version="^1.1.3" role="dependency" />
    <lib name="@radix-ui/react-collapsible" version="^1.1.2" role="dependency" />
    <lib name="@radix-ui/react-dialog" version="^1.1.5" role="dependency" />
    <lib name="@radix-ui/react-dropdown-menu" version="^2.1.4" role="dependency" />
    <lib name="@radix-ui/react-label" version="^2.1.1" role="dependency" />
    <lib name="@radix-ui/react-progress" version="^1.1.0" role="dependency" />
    <lib name="@radix-ui/react-radio-group" version="^1.2.2" role="dependency" />
    <lib name="@radix-ui/react-scroll-area" version="^1.2.0" role="dependency" />
    <lib name="@radix-ui/react-select" version="^2.1.5" role="dependency" />
    <lib name="@radix-ui/react-separator" version="^1.1.1" role="dependency" />
    <lib name="@radix-ui/react-slot" version="^1.1.1" role="dependency" />
    <lib name="@radix-ui/react-switch" version="^1.1.2" role="dependency" />
    <lib name="@radix-ui/react-tabs" version="^1.1.12" role="dependency" />
    <lib name="@radix-ui/react-toast" version="^1.2.2" role="dependency" />
    <lib name="@radix-ui/react-tooltip" version="^1.1.6" role="dependency" />
    <lib name="@radix-ui/react-visually-hidden" version="^1.2.3" role="dependency" />
    <lib name="@sentry/nextjs" version="^9.18.0" role="dependency" />
    <lib name="@supabase/ssr" version="^0.7.0" role="dependency" />
    <lib name="@supabase/supabase-js" version="^2.77.0" role="dependency" />
    <lib name="@svgr/webpack" version="^8.1.0" role="dependency" />
    <lib name="@tanstack/react-query" version="^5.65.1" role="dependency" />
    <lib name="@tiptap/extension-color" version="^2.12.0" role="dependency" />
    <lib name="@tiptap/extension-font-size" version="3.0.0-next.3" role="dependency" />
    <lib name="@tiptap/extension-text-style" version="^2.12.0" role="dependency" />
    <lib name="@tiptap/react" version="^2.12.0" role="dependency" />
    <lib name="@tiptap/starter-kit" version="^2.12.0" role="dependency" />
    <lib name="browser-image-compression" version="^2.0.2" role="dependency" />
    <lib name="class-variance-authority" version="^0.7.0" role="dependency" />
    <lib name="clsx" version="^2.1.1" role="dependency" />
    <lib name="html-to-image" version="^1.11.13" role="dependency" />
    <lib name="lucide-react" version="^0.456.0" role="dependency" />
    <lib name="motion" version="^11.11.17" role="dependency" />
    <lib name="next" version="15.0.2" role="dependency" />
    <lib name="react" version="19.0.0-rc-02c0e824-20241028" role="dependency" />
    <lib name="react-dom" version="19.0.0-rc-02c0e824-20241028" role="dependency" />
    <lib name="react-error-boundary" version="^5.0.0" role="dependency" />
    <lib name="react-hook-form" version="^7.54.2" role="dependency" />
    <lib name="react-image-crop" version="^11.0.10" role="dependency" />
    <lib name="react-rnd" version="^10.5.2" role="dependency" />
    <lib name="tailwind-merge" version="^2.5.4" role="dependency" />
    <lib name="tailwindcss-animate" version="^1.0.7" role="dependency" />
    <lib name="zod" version="^3.24.1" role="dependency" />
    <lib name="zustand" version="^5.0.3" role="dependency" />
    <lib name="@types/node" version="^20" role="dependency" />
    <lib name="@types/react" version="^18" role="dependency" />
    <lib name="@types/react-dom" version="^18" role="dependency" />
    <lib name="eslint" version="^8" role="dependency" />
    <lib name="eslint-config-next" version="15.0.2" role="dependency" />
    <lib name="postcss" version="^8" role="dependency" />
    <lib name="tailwindcss" version="^3.4.1" role="dependency" />
    <lib name="typescript" version="^5" role="dependency" />
  </dependencies>
</codebase>
```
