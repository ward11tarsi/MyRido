import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveCurrentAppTarget } from './apps/appTargets';
import { DashboardShell } from './components/DashboardShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LegalPagesView, type LegalDocTab } from './components/LegalPagesView';
import { MyRidoDownHolder } from './components/MyRidoDownHolder';
import { MyRidoHeader, type HeaderKycStatus, type NavTabItem } from './components/MyRidoHeader';
import { OtpAuthModal } from './components/OtpAuthModal';
import { PublicFleetView } from './components/PublicFleetView';
import { formatShortDate, StatusText } from './components/StatusText';
import {
  apiRequest,
  clearStoredToken,
  getStoredToken,
  isAuthApiError,
  logoutSession,
  type PublicCatalog,
  type PublicTripShare,
  type WorkspaceBootstrap,
} from './lib/api';
import { useDashboardWidgets, useThemeAndLanguage } from './lib/dashboardPrefs';
import { groupIdForSection, groupsForProfile, sectionsForTab } from './lib/tabGroups';
import { tr, tx, type AppLanguage, type WidgetMeta } from './lib/i18n';
import { registerNotificationServiceWorker } from './lib/notifications';
import { useRealtimeSync } from './lib/useRealtimeSync';
import { canAdminViewTab, MYRIDO_COMPANY, type AdminDashboardTab, type UserRole } from './shared/company';

// Role workspaces are code-split so each user only downloads the dashboard for their own role.
const CustomerWorkspace = lazy(() => import('./workspaces/CustomerWorkspace').then((m) => ({ default: m.CustomerWorkspace })));
const PartnerWorkspace = lazy(() => import('./workspaces/PartnerWorkspace').then((m) => ({ default: m.PartnerWorkspace })));
const AdminWorkspace = lazy(() => import('./workspaces/AdminWorkspace').then((m) => ({ default: m.AdminWorkspace })));
const SuperAdminWorkspace = lazy(() => import('./workspaces/SuperAdminWorkspace').then((m) => ({ default: m.SuperAdminWorkspace })));
const ProfileSettingsView = lazy(() => import('./components/ProfileSettingsView').then((m) => ({ default: m.ProfileSettingsView })));

function WorkspaceLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-live="polite">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#FF5A00] border-t-transparent" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

function getPublicTabs(lang: AppLanguage): NavTabItem[] {
  return [
    // First 4 also fill the mobile bottom bar; "Help" holds contact details and About.
    { id: 'home', label: tx('Home', 'होम', lang), emoji: '🏠' },
    { id: 'fleet', label: tx('Book', 'बुक करें', lang), emoji: '🚗' },
    { id: 'offers', label: tx('Offers', 'ऑफ़र', lang), emoji: '🎁' },
    { id: 'hubs', label: tx('Hubs', 'हब', lang), emoji: '📍' },
    { id: 'contact', label: tx('Help', 'मदद', lang), emoji: '💬' },
  ];
}

const PUBLIC_TAB_IDS = new Set(['home', 'fleet', 'hubs', 'offers', 'about', 'contact', 'privacy', 'terms', 'refund']);

type TabProfile = { role: UserRole; permissions?: readonly string[] | null };

function getRoleTabs(tabProfile: TabProfile, lang: AppLanguage): NavTabItem[] {
  // A few main tabs per role; each one shows several related sections (see src/lib/tabGroups.ts).
  return groupsForProfile(tabProfile).map((g) => ({ id: g.id, label: tx(g.en, g.hi, lang), emoji: g.emoji }));
}

const ROLE_WIDGETS: Record<UserRole, WidgetMeta[]> = {
  customer: [
    { id: 'active_trip_banner', labelEn: 'Your Trip (Current / Upcoming)', labelHi: 'आपकी ट्रिप (मौजूदा / आने वाली)' },
    { id: 'wallet_points', labelEn: 'Wallet & Loyalty Summary', labelHi: 'वॉलेट और लॉयल्टी सारांश' },
    { id: 'sos_quick', labelEn: 'Quick Emergency SOS', labelHi: 'त्वरित आपातकालीन SOS' },
  ],
  partner: [
    { id: 'fleet_kpis', labelEn: 'Fleet & Profit KPIs', labelHi: 'फ्लीट और लाभ KPI' },
    { id: 'doc_expiry_alerts', labelEn: 'Document Expiry Reminders', labelHi: 'दस्तावेज़ समाप्ति अलर्ट' },
    { id: 'gps_summary', labelEn: 'Live Fleet GPS Snapshot', labelHi: 'लाइव फ्लीट GPS स्थिति' },
  ],
  admin: [
    { id: 'ops_kpis', labelEn: 'Operations & Volume KPIs', labelHi: 'ऑपरेशंस और वॉल्यूम KPI' },
    { id: 'sos_fraud_banner', labelEn: 'Live SOS & Fraud Queue', labelHi: 'लाइव SOS और फ्रॉड कतार' },
    { id: 'ops_map', labelEn: 'Live Hub Operations Map', labelHi: 'लाइव हब ऑपरेशंस मैप' },
  ],
  superadmin: [
    { id: 'company_pnl', labelEn: 'Company Net Profit & Volume', labelHi: 'कंपनी शुद्ध लाभ और वॉल्यूम' },
    { id: 'recon_matrix', labelEn: 'Cashfree Reconciliation Matrix', labelHi: 'Cashfree मिलान मैट्रिक्स' },
    { id: 'security_pulse', labelEn: 'System Health & Security Pulse', labelHi: 'सिस्टम और सुरक्षा स्थिति' },
  ],
};

function readRouteLocation(): { roleSegment: string | null; tab: string; legalDoc: LegalDocTab | null } {
  if (typeof window === 'undefined') return { roleSegment: null, tab: 'home', legalDoc: null };
  const isFileProtocol = window.location.protocol === 'file:';
  const rawPath = isFileProtocol
    ? window.location.hash.replace(/^#/, '')
    : window.location.pathname;
  const parts = rawPath.split('/').map((s) => s.trim().toLowerCase()).filter(Boolean);

  if (parts[0] === 'legal' && (parts[1] === 'privacy' || parts[1] === 'terms' || parts[1] === 'refund')) {
    return { roleSegment: null, tab: parts[1], legalDoc: parts[1] };
  }
  if (parts[0] && ['customer', 'partner', 'admin', 'superadmin'].includes(parts[0])) {
    return { roleSegment: parts[0], tab: parts[1] || 'home', legalDoc: null };
  }
  if (parts[0] && PUBLIC_TAB_IDS.has(parts[0])) {
    const doc = parts[0] === 'privacy' || parts[0] === 'terms' || parts[0] === 'refund' ? (parts[0] as LegalDocTab) : null;
    return { roleSegment: null, tab: parts[0] === 'about' ? 'contact' : parts[0], legalDoc: doc };
  }
  return { roleSegment: null, tab: parts[0] || 'home', legalDoc: null };
}

function buildRoutePath(role: UserRole | null, tab: string, legalDoc: LegalDocTab | null): string {
  if (legalDoc) return `/legal/${legalDoc}`;
  if (role) return `/${role}/${tab}`;
  return tab === 'home' ? '/' : `/${tab}`;
}

export default function App() {
  const appTarget = resolveCurrentAppTarget();
  const { theme, toggleTheme, lang, toggleLang } = useThemeAndLanguage();
  const initialRoute = useMemo(() => readRouteLocation(), []);

  const [data, setData] = useState<WorkspaceBootstrap | null>(null);
  const [publicCatalog, setPublicCatalog] = useState<PublicCatalog | null>(null);
  const [activeTab, setActiveTab] = useState<string>(initialRoute.tab);
  const [activeLegalDoc, setActiveLegalDoc] = useState<LegalDocTab | null>(initialRoute.legalDoc);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [networkBanner, setNetworkBanner] = useState<string | null>(null);
  const [returnBanner, setReturnBanner] = useState<string | null>(null);
  const [sharedTripView, setSharedTripView] = useState<PublicTripShare | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const previousRoleRef = useRef<UserRole | null>(null);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  useEffect(() => {
    void registerNotificationServiceWorker();
  }, []);

  const syncBrowserUrl = useCallback((role: UserRole | null, tab: string, legalDoc: LegalDocTab | null, replace = false) => {
    if (typeof window === 'undefined') return;
    const nextPath = buildRoutePath(role, tab, legalDoc);
    if (window.location.protocol === 'file:') {
      const nextHash = `#${nextPath}`;
      if (window.location.hash !== nextHash) {
        if (replace) {
          window.history.replaceState(null, '', nextHash);
        } else {
          window.history.pushState(null, '', nextHash);
        }
      }
      return;
    }
    const url = new URL(window.location.href);
    if (url.pathname !== nextPath) {
      const target = `${nextPath}${url.search}${url.hash}`;
      if (replace) {
        window.history.replaceState(null, '', target);
      } else {
        window.history.pushState(null, '', target);
      }
    }
  }, []);

  const currentRole: UserRole = data?.profile.role || 'customer';
  const widgetDefaults = useMemo(() => ROLE_WIDGETS[currentRole], [currentRole]);
  const { orderedWidgets, hiddenIds, isVisible, toggleWidget, moveWidget, resetWidgets } = useDashboardWidgets(
    data ? data.profile.role : 'public',
    widgetDefaults
  );

  const loadWorkspace = useCallback(async () => {
    setError(null);
    const token = getStoredToken();

    try {
      if (token) {
        try {
          const boot = await apiRequest<WorkspaceBootstrap>('/api/workspace/bootstrap');
          setNetworkBanner(null);
          const previousRole = previousRoleRef.current;
          previousRoleRef.current = boot.profile.role;
          setData(boot);

          const validTabs = getRoleTabs(boot.profile, 'en');
          const urlRoute = readRouteLocation();
          const urlTab = groupIdForSection(boot.profile.role, urlRoute.tab) ?? urlRoute.tab;
          setActiveTab((prev) => {
            if (
              (urlRoute.roleSegment === boot.profile.role || urlRoute.roleSegment === null) &&
              validTabs.some((t) => t.id === urlTab)
            ) {
              return urlTab;
            }
            if (previousRole !== boot.profile.role || !validTabs.some((t) => t.id === prev)) {
              return validTabs[0].id;
            }
            return prev;
          });
          return;
        } catch (err) {
          if (isAuthApiError(err)) {
            clearStoredToken();
            previousRoleRef.current = null;
            setData(null);
          } else {
            // Preserve token & session during network outages or transient 5xx errors!
            setNetworkBanner(
              err instanceof Error
                ? err.message
                : tr('offlineBanner', lang)
            );
            return;
          }
        }
      } else {
        previousRoleRef.current = null;
        setData(null);
      }

      const catalog = await apiRequest<PublicCatalog>('/api/public/catalog');
      setNetworkBanner(null);
      setPublicCatalog(catalog);
      setActiveTab((prev) => (PUBLIC_TAB_IDS.has(prev) ? prev : 'home'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to connect to MyRido server.';
      if (data || publicCatalog) {
        setNetworkBanner(msg);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [data, publicCatalog, lang]);

  useEffect(() => {
    void loadWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sync automatically when browser comes back online
  useEffect(() => {
    if (typeof window === 'undefined') return;
    function handleOnline() {
      void loadWorkspace();
    }
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [loadWorkspace]);

  // Browser Back/Forward (popstate) support
  useEffect(() => {
    if (typeof window === 'undefined') return;
    function handlePopState() {
      const parsed = readRouteLocation();
      setActiveLegalDoc(parsed.legalDoc);
      if (parsed.legalDoc) {
        setActiveTab(parsed.legalDoc);
        return;
      }
      if (data) {
        const validTabs = getRoleTabs(data.profile, 'en');
        const parsedTab = groupIdForSection(data.profile.role, parsed.tab) ?? parsed.tab;
        if (validTabs.some((t) => t.id === parsedTab)) {
          setActiveTab(parsedTab);
        } else {
          setActiveTab(validTabs[0].id);
        }
      } else if (PUBLIC_TAB_IDS.has(parsed.tab)) {
        setActiveTab(parsed.tab);
      } else {
        setActiveTab('home');
      }
    }
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [data]);

  const handleSelectTab = useCallback(
    (tabId: string) => {
      if (tabId === 'privacy' || tabId === 'terms' || tabId === 'refund') {
        setActiveLegalDoc(tabId);
        setActiveTab(tabId);
        syncBrowserUrl(data?.profile.role || null, tabId, tabId);
        if (typeof window !== 'undefined') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }
      setActiveLegalDoc(null);
      // Links to a section (e.g. 'rewards') open the main tab that contains it; public 'about' lives in Help.
      const mainTab = data ? groupIdForSection(data.profile.role, tabId) ?? tabId : tabId === 'about' ? 'contact' : tabId;
      setActiveTab(mainTab);
      syncBrowserUrl(data?.profile.role || null, mainTab, null);
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    [data, syncBrowserUrl]
  );

  // Sync canonical URL once role/tab stabilizes
  useEffect(() => {
    if (loading) return;
    syncBrowserUrl(data?.profile.role || null, activeTab, activeLegalDoc, true);
  }, [data?.profile.role, activeTab, activeLegalDoc, loading, syncBrowserUrl]);

  // Real-time WebSocket / SSE updates + native Push notifications
  const { connected: realtimeConnected } = useRealtimeSync({
    enabled: Boolean(data),
    onRefresh: loadWorkspace,
    pushEnabled: data?.profile.notificationPreferences?.push !== false,
  });

  // Handle ?tripShare=SHR-... public shared trip link
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const shareToken = url.searchParams.get('tripShare') || url.searchParams.get('share');
    if (!shareToken) return;
    apiRequest<PublicTripShare>(`/api/public/trip-share/${encodeURIComponent(shareToken)}`)
      .then((res) => setSharedTripView(res))
      .catch((err) => setReturnBanner(err instanceof Error ? err.message : 'Shared trip link expired.'));
  }, []);

  // Verify Cashfree PG return URL (?order_id=CF_ORD_...) strictly via server API
  useEffect(() => {
    if (!data || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const orderId = url.searchParams.get('order_id');
    if (!orderId) return;

    url.searchParams.delete('order_id');
    window.history.replaceState({}, '', url.pathname + url.search);

    apiRequest<{ payment: { status: string; providerNote: string } }>('/api/payments/cashfree/verify', {
      method: 'POST',
      body: JSON.stringify({ cashfreeOrderId: orderId }),
    })
      .then((res) => {
        setReturnBanner(`Cashfree order ${orderId}: ${res.payment.status} — ${res.payment.providerNote}`);
        return loadWorkspace();
      })
      .catch((err) => {
        setReturnBanner(err instanceof Error ? err.message : 'Unable to verify returned Cashfree order.');
      });
  }, [data, loadWorkspace]);

  async function handleLoggedOut() {
    previousRoleRef.current = null;
    setData(null);
    setActiveLegalDoc(null);
    setActiveTab('home');
    syncBrowserUrl(null, 'home', null, true);
    await loadWorkspace();
  }

  async function handleMarkNotificationRead(id: string) {
    try {
      await apiRequest(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
      await loadWorkspace();
    } catch {
      // ignore transient error
    }
  }

  async function handleMarkAllNotificationsRead() {
    try {
      await apiRequest('/api/notifications/read-all', { method: 'POST' });
      await loadWorkspace();
    } catch {
      // ignore transient error
    }
  }

  if (loading && !data && !publicCatalog) {
    return (
      <div className="min-h-screen bg-white dark:bg-[#111318] flex flex-col items-center justify-center p-6">
        <div className="text-3xl font-extrabold text-[#FF5A00]">MyRido</div>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-2">
          {tx('Loading MyRido…', 'MyRido खुल रहा है…', lang)}
        </p>
      </div>
    );
  }

  if (error && !data && !publicCatalog) {
    return (
      <div className="min-h-screen bg-white dark:bg-[#111318] flex flex-col items-center justify-center p-6 text-center">
        <div className="text-3xl font-extrabold text-[#FF5A00]">MyRido</div>
        <p className="text-sm text-[#B91C1C] dark:text-[#F87171] mt-3">❌ {error}</p>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void loadWorkspace();
          }}
          className="mt-4 min-h-[42px] px-5 py-2 rounded-lg bg-[#E65100] hover:bg-[#CC4700] text-white text-sm font-semibold cursor-pointer"
        >
          {tx('Retry Connection', 'पुनः कनेक्ट करें', lang)}
        </button>
      </div>
    );
  }

  const roleMismatch = Boolean(data && appTarget.lockedRole && data.profile.role !== appTarget.lockedRole);
  const publicTabs = getPublicTabs(lang);
  const tabs: NavTabItem[] = data ? getRoleTabs(data.profile, lang) : publicTabs;
  const accountLabel = data ? tr('signOut', lang) : tr('signIn', lang);

  async function handleHeaderAction() {
    if (data) {
      await logoutSession();
      await handleLoggedOut();
      return;
    }
    setAuthModalOpen(true);
  }

  const currentKycStatus: HeaderKycStatus | null = data
    ? data.kycRecords.find((k) => k.profileId === data.profile.id)?.status ??
      (data.profile.role === 'customer' || data.profile.role === 'partner' ? 'NOT_SUBMITTED' : 'STAFF')
    : null;

  return (
    <ErrorBoundary lang={lang}>
      <div className="min-h-screen bg-white dark:bg-[#111318] text-neutral-900 dark:text-neutral-100 flex flex-col pb-20 md:pb-8">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-[#E65100] focus:text-white focus:text-xs focus:font-bold"
        >
          {tx('Skip to main content', 'मुख्य सामग्री पर जाएं', lang)}
        </a>

        <MyRidoHeader
          profile={data?.profile || null}
          kycStatus={currentKycStatus}
          tabs={tabs}
          activeTab={activeTab}
          onSelectTab={handleSelectTab}
          onOpenAuthModal={handleHeaderAction}
          accountLabel={accountLabel}
          showSubNav={!data || roleMismatch}
          lang={lang}
          onToggleLang={toggleLang}
          notifications={data?.notifications || []}
          onMarkNotificationRead={handleMarkNotificationRead}
          onMarkAllNotificationsRead={handleMarkAllNotificationsRead}
          realtimeConnected={realtimeConnected}
        />

        {networkBanner && (
          <div role="status" aria-live="polite" className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800">
            <div className="max-w-[1440px] mx-auto px-4 sm:px-8 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="font-semibold text-[#B45309] dark:text-[#FBBF24]">
                ⏳ {networkBanner}
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void loadWorkspace()}
                  className="px-3 py-1 rounded bg-[#E65100] text-white font-bold cursor-pointer"
                >
                  {tr('retrySync', lang)}
                </button>
                <button
                  type="button"
                  onClick={() => setNetworkBanner(null)}
                  className="text-neutral-600 dark:text-neutral-400 hover:text-[#FF5A00] font-semibold cursor-pointer"
                >
                  {tr('close', lang)}
                </button>
              </div>
            </div>
          </div>
        )}

        {returnBanner && (
          <div className="bg-white dark:bg-[#111318] border-b border-neutral-100 dark:border-neutral-800">
            <div className="max-w-[1440px] mx-auto px-4 sm:px-8 py-2.5 flex items-center justify-between gap-4 text-xs">
              <span className="font-semibold text-[#0369A1] dark:text-[#38BDF8]">ℹ️ {returnBanner}</span>
              <button
                type="button"
                onClick={() => setReturnBanner(null)}
                className="text-neutral-600 dark:text-neutral-400 hover:text-[#FF5A00] font-semibold cursor-pointer"
              >
                {tr('close', lang)}
              </button>
            </div>
          </div>
        )}

        {sharedTripView && (
          <div className="max-w-[1440px] w-full mx-auto px-4 sm:px-8 py-4 bg-white dark:bg-[#111318] border-b border-neutral-100 dark:border-neutral-800">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
              <div>
                <div className="font-extrabold text-sm text-[#FF5A00]">
                  🔗 {tx('Live Shared Trip', 'लाइव शेयर्ड ट्रिप', lang)} · {sharedTripView.bookingCode} ({sharedTripView.vehicleTitle})
                </div>
                <div className="text-neutral-700 dark:text-neutral-300 mt-0.5">
                  {sharedTripView.regNumber} · {sharedTripView.hubName}, {sharedTripView.city} · Shared with {sharedTripView.sharedWithName}
                  {sharedTripView.expiresAt ? ` · Expires ${formatShortDate(sharedTripView.expiresAt)}` : ''}
                </div>
                {sharedTripView.telemetry && (
                  <div className="font-mono text-[#15803D] dark:text-[#4ADE80] mt-0.5">
                    GPS: {sharedTripView.telemetry.locationLabel} ({sharedTripView.telemetry.speedKmh} km/h · Ping {formatShortDate(sharedTripView.telemetry.lastPingAt)})
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <StatusText status={sharedTripView.status} lang={lang} />
                <button
                  type="button"
                  onClick={() => setSharedTripView(null)}
                  className="text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:text-[#FF5A00] cursor-pointer"
                >
                  {tr('close', lang)}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeLegalDoc ? (
          <main id="main-content" tabIndex={-1} className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-8 py-4 bg-white dark:bg-[#111318] focus:outline-none">
            <LegalPagesView
              doc={activeLegalDoc}
              lang={lang}
              onSelectDoc={(doc) => handleSelectTab(doc)}
              onBackToFleet={() => handleSelectTab(data ? getRoleTabs(data.profile, lang)[0].id : 'home')}
            />
          </main>
        ) : roleMismatch && data ? (
          <main id="main-content" tabIndex={-1} className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-8 py-8 bg-white dark:bg-[#111318] focus:outline-none">
            <section className="max-w-xl mx-auto py-16 text-center space-y-4">
              <h1 className="text-2xl font-extrabold text-[#FF5A00]">{appTarget.title}</h1>
              <p className="text-sm text-[#B91C1C] dark:text-[#F87171] font-semibold">
                ❌ {tx('Signed-in account role', 'वर्तमान लॉगिन भूमिका', lang)} ({data.profile.role.toUpperCase()}){' '}
                {tx('is not authorized for', 'को इसकी अनुमति नहीं है:', lang)} {appTarget.title} (
                {appTarget.lockedRole?.toUpperCase()}).
              </p>
              <div className="flex items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={async () => {
                    await logoutSession();
                    await handleLoggedOut();
                    setAuthModalOpen(true);
                  }}
                  className="min-h-[42px] px-5 py-2 rounded-lg bg-[#E65100] hover:bg-[#CC4700] text-white text-sm font-semibold cursor-pointer"
                >
                  {tx('Sign Out & Switch Account', 'साइन आउट कर अकाउंट बदलें', lang)}
                </button>
              </div>
            </section>
          </main>
        ) : data ? (
          <DashboardShell
            tabs={tabs}
            activeTab={activeTab}
            onSelectTab={handleSelectTab}
            lang={lang}
          >
            <ErrorBoundary lang={lang} onReset={() => handleSelectTab(tabs[0].id)}>
              <Suspense fallback={<WorkspaceLoading />}>
              {(() => {
                const sections = sectionsForTab(data.profile, activeTab);
                const workspaceSections = sections.filter((x) => x !== 'profile' && x !== 'settings');
                const accountView = (mode: 'profile' | 'settings') => (
                  <ProfileSettingsView
                    key={mode}
                    mode={mode}
                    data={data}
                    lang={lang}
                    onToggleLang={toggleLang}
                    theme={theme}
                    onToggleTheme={toggleTheme}
                    widgets={orderedWidgets}
                    hiddenWidgetIds={hiddenIds}
                    onToggleWidget={toggleWidget}
                    onMoveWidget={moveWidget}
                    onResetWidgets={resetWidgets}
                    onRefresh={loadWorkspace}
                    onSelectTab={handleSelectTab}
                    onLogout={async () => {
                      await logoutSession();
                      await handleLoggedOut();
                    }}
                  />
                );
                const common = {
                  data,
                  activeTab,
                  sections: workspaceSections,
                  lang,
                  orderedWidgets,
                  isWidgetVisible: isVisible,
                  onRefresh: loadWorkspace,
                  onSelectTab: handleSelectTab,
                };
                return (
                  <div className="space-y-12">
                    {sections[0] === 'profile' && accountView('profile')}
                    {workspaceSections.length > 0 && (
                      <>
                        {data.profile.role === 'customer' && <CustomerWorkspace {...common} />}
                        {data.profile.role === 'partner' && <PartnerWorkspace {...common} />}
                        {data.profile.role === 'admin' && <AdminWorkspace {...common} />}
                        {data.profile.role === 'superadmin' && <SuperAdminWorkspace {...common} />}
                      </>
                    )}
                    {sections.includes('profile') && sections[0] !== 'profile' && accountView('profile')}
                    {sections.includes('settings') && accountView('settings')}
                  </div>
                );
              })()}
              </Suspense>
            </ErrorBoundary>
          </DashboardShell>
        ) : (
          <main id="main-content" tabIndex={-1} className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-8 py-8 bg-white dark:bg-[#111318] focus:outline-none">
            {appTarget.lockedRole && appTarget.lockedRole !== 'customer' ? (
              <section className="max-w-lg mx-auto py-16 text-center space-y-5">
                <h1 className="text-3xl font-extrabold text-[#FF5A00]">{appTarget.title}</h1>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  {tx(
                    `Sign in with your authorized MyRido ${appTarget.lockedRole.toUpperCase()} credentials to access this dedicated ${appTarget.platform} workspace.`,
                    `इस ${appTarget.platform} कार्यक्षेत्र तक पहुँचने के लिए अपने अधिकृत MyRido ${appTarget.lockedRole.toUpperCase()} खाते से साइन इन करें।`,
                    lang
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => setAuthModalOpen(true)}
                  className="min-h-[44px] px-6 py-2.5 rounded-lg bg-[#E65100] hover:bg-[#CC4700] text-white text-sm font-semibold cursor-pointer"
                >
                  {tx('Sign In to Continue', 'जारी रखने के लिए साइन इन करें', lang)}
                </button>
              </section>
            ) : publicCatalog ? (
              <PublicFleetView
                catalog={publicCatalog}
                activeTab={activeTab}
                lang={lang}
                onSelectTab={handleSelectTab}
                onOpenAuthModal={() => setAuthModalOpen(true)}
              />
            ) : null}
          </main>
        )}

        <footer className="bg-white dark:bg-[#111318] mt-12 border-t border-neutral-100 dark:border-neutral-800">
          <div className="max-w-[1440px] mx-auto px-4 sm:px-8 py-6 space-y-3 text-xs text-neutral-500 dark:text-neutral-400">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <span className="font-bold text-[#FF5A00]">{MYRIDO_COMPANY.brandName}</span>
                <span className="mx-2" aria-hidden="true">·</span>
                <span className="text-neutral-700 dark:text-neutral-300 font-medium">{MYRIDO_COMPANY.companyName}</span>
                <span className="mx-2" aria-hidden="true">·</span>
                <span>{MYRIDO_COMPANY.address}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold">
                <a href={`tel:${MYRIDO_COMPANY.supportPhoneTel}`} className="text-neutral-800 dark:text-neutral-200 hover:text-[#FF5A00] whitespace-nowrap">
                  📞 {MYRIDO_COMPANY.supportPhone}
                </a>
                <a href={`mailto:${MYRIDO_COMPANY.supportEmail}`} className="text-neutral-800 dark:text-neutral-200 hover:text-[#FF5A00] whitespace-nowrap">
                  ✉️ {MYRIDO_COMPANY.supportEmail}
                </a>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-neutral-600 dark:text-neutral-400">
              <span>MCA: {MYRIDO_COMPANY.register.MCA}</span>
              <span>PAN: {MYRIDO_COMPANY.register.PAN}</span>
              <span>TAN: {MYRIDO_COMPANY.register.TAN}</span>
              <span>GST: {MYRIDO_COMPANY.register.GST}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-neutral-100 dark:border-neutral-800">
              <div className="flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => handleSelectTab('privacy')}
                  className="font-semibold text-neutral-600 dark:text-neutral-300 hover:text-[#FF5A00] cursor-pointer"
                >
                  {tr('pub_privacy', lang)}
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectTab('terms')}
                  className="font-semibold text-neutral-600 dark:text-neutral-300 hover:text-[#FF5A00] cursor-pointer"
                >
                  {tr('pub_terms', lang)}
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectTab('refund')}
                  className="font-semibold text-neutral-600 dark:text-neutral-300 hover:text-[#FF5A00] cursor-pointer"
                >
                  {tr('pub_refund', lang)}
                </button>
              </div>
              <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                © {new Date().getFullYear()} {MYRIDO_COMPANY.companyName}
                {data && realtimeConnected ? ` · 🟢 ${tr('liveConnected', lang)}` : ''}
              </span>
            </div>
          </div>
        </footer>

        <MyRidoDownHolder
          tabs={tabs}
          activeTab={activeTab}
          onSelectTab={handleSelectTab}
          profile={data?.profile || null}
          bookings={data?.bookings || []}
          lang={lang}
          onOpenAuthModal={() => setAuthModalOpen(true)}
          onSosDispatched={loadWorkspace}
        />

        <OtpAuthModal
          open={authModalOpen}
          onClose={() => setAuthModalOpen(false)}
          currentProfile={data?.profile || null}
          appTarget={appTarget}
          lang={lang}
          onAuthenticated={loadWorkspace}
          onLoggedOut={handleLoggedOut}
          onOpenLegal={(doc) => handleSelectTab(doc)}
        />
      </div>
    </ErrorBoundary>
  );
}
