import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BearerAuthProvider, useBearerAuth } from "./api/bearerAuth";
import { Projects } from "./pages/Projects";
import { ProjectDetail } from "./pages/ProjectDetail";
import { OfflineBanner } from "./components/OfflineBanner";
import { DaemonFatalBanner } from "./components/DaemonFatalBanner";
import {
  EntitlementBanner,
  useEntitlementEnforcement,
} from "./components/EntitlementGate";
import { TransferDock } from "./components/TransferDock";
import { SignInScreen } from "./components/SignInScreen";

// Secondary routes and dialogs are code-split: most launches land on
// Projects and never visit Activity / Transfers / Invitations /
// Pricing, and Settings / NewProject only matter once the user
// explicitly opens them. Splitting these trims roughly a third of
// the first-paint JS — the saved bytes also mean less for WebView2's
// browser process to parse, which has been our crash hot-spot.
const Invitations = lazy(() =>
  import("./pages/Invitations").then((m) => ({ default: m.Invitations })),
);
const Activity = lazy(() =>
  import("./pages/Activity").then((m) => ({ default: m.Activity })),
);
const Transfers = lazy(() =>
  import("./pages/Transfers").then((m) => ({ default: m.Transfers })),
);
const Pricing = lazy(() =>
  import("./pages/Pricing").then((m) => ({ default: m.Pricing })),
);
const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((m) => ({
    default: m.SettingsModal,
  })),
);
const NewProjectModal = lazy(() =>
  import("./components/NewProjectModal").then((m) => ({
    default: m.NewProjectModal,
  })),
);
import { DeviceRegistrar } from "./components/DeviceRegistrar";
import { PendingDeviceAutoAccept } from "./components/PendingDeviceAutoAccept";
import { CommentNotifier } from "./components/CommentNotifier";
import { Toaster } from "./components/Toaster";
import { RevokedScreen } from "./components/RevokedScreen";
import { InvitationBridge } from "./components/InvitationBridge";
import { type Section } from "./components/Sidebar";
import { NavRail } from "./components/NavRail";
import { ProjectsNav, type OpenProjectOptions } from "./components/ProjectsNav";
import type { VideoPreviewFile } from "./components/VideoPreviewModal";
import { RealtimeProvider } from "./realtime/RealtimeProvider";
import { CloudProvider } from "./api/cloud/provider";
import {
  useConfig,
  useFsWatcherDelayMigration,
  usePendingDevices,
  usePendingFolders,
  useSystemStatus,
} from "./api/hooks";
import { useAllTransfers } from "./realtime/hooks";
import { useAcceptedSince, useCloudMe, useMyInvitations } from "./api/cloud/hooks";
import { useDesktopNotifications, useInvitationNotifications } from "./api/useDesktopNotifications";
import { useQueryClient } from "@tanstack/react-query";
import { cloudKeys } from "./api/cloud/hooks";
import { bc } from "./lib/breadcrumb";

// React Query defaults tuned for this app:
//   * `refetchOnWindowFocus` was firing every long-poll (config, status,
//     events) whenever the user switched tabs or alt-tabbed back to the
//     window. In a desktop app the data is already kept fresh by the
//     RealtimeProvider's event stream, so the focus refetch was pure
//     waste — and it added load right when the user was returning.
//   * `gcTime` of 2 min keeps results cached for a short while so a
//     section round-trip doesn't refetch immediately, but drops the
//     payload before stale data piles up (daemon config + browse
//     trees can be several MB on a large library).
//   * `staleTime` of 30 s lets non-realtime queries skip a fetch when
//     a component remounts (e.g. opening a modal). Realtime queries
//     opt out individually where needed.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      gcTime: 2 * 60 * 1000,
      staleTime: 30 * 1000,
    },
  },
});

// Cloud is opt-in. When the control-plane URL isn't set we run as a
// pure local app — no sign-in screen, no device-transfer gating, no
// billing. This keeps the daemon-frontend experience usable for
// anyone who hasn't (yet) wired up a cloud backend.
const CLOUD_API_URL = import.meta.env.VITE_CLOUD_API_URL ?? "";

// Exported so components that *only* make sense with auth (My Devices,
// account/billing settings) can render conditionally. Single source
// of truth — components don't re-read the env var. The desktop app
// no longer embeds Clerk; auth is enabled whenever there's a backend
// URL to talk to.
export const AUTH_ENABLED = !!CLOUD_API_URL;

// HIDE_BILLING flips the app into a "free-trial only" mode for builds
// we ship to testers: no Billing sidebar item, no Pricing tab, no
// Upgrade / Manage-subscription CTAs, no "Plan limit reached → upgrade"
// prompts. The user still sees their trial status (Trial ends DD/MM)
// so they understand the time-bounded nature, but every path that
// would otherwise lead to Stripe is hidden. Set
// VITE_HIDE_BILLING=true in .env.local and rebuild to enable.
export const HIDE_BILLING =
  String(import.meta.env.VITE_HIDE_BILLING ?? "")
    .toLowerCase()
    .trim() === "true";

export function App() {
  if (!AUTH_ENABLED) {
    return (
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider>
          <AppShell />
        </RealtimeProvider>
      </QueryClientProvider>
    );
  }
  return (
    <BearerAuthProvider>
      <QueryClientProvider client={queryClient}>
        <AuthGate />
      </QueryClientProvider>
    </BearerAuthProvider>
  );
}

// AuthGate switches between the sign-in screen and the entitled app
// based on whether the Wails-stored bearer token is present. While
// the token is being read (first paint after launch), render nothing
// — the read returns in well under a frame, and a spinner would just
// flash on every cold start.
function AuthGate() {
  const auth = useBearerAuth();
  if (auth.isLoading) return null;
  if (!auth.isSignedIn) return <SignInScreen />;
  return (
    <CloudProvider baseURL={CLOUD_API_URL}>
      <RealtimeProvider>
        <EntitledApp />
      </RealtimeProvider>
    </CloudProvider>
  );
}

function EntitledApp() {
  const sys = useSystemStatus();
  const myID = sys.data?.myID;
  const me = useCloudMe(myID);
  const qc = useQueryClient();

  const revoked =
    myID !== undefined &&
    me.data !== undefined &&
    me.data.currentDeviceRevokedAt !== undefined &&
    me.data.currentDeviceRevokedAt !== null;

  if (revoked) {
    return (
      <RevokedScreen
        onTakeBackSuccess={() => {
          qc.invalidateQueries({ queryKey: cloudKeys.me });
        }}
      />
    );
  }

  return (
    <>
      <DeviceRegistrar />
      <InvitationBridge />
      <CommentNotifier />
      <AppShell />
    </>
  );
}

// View encodes both the active sidebar section and (when applicable)
// a project-detail drill-down. Using a tagged shape keeps the rest of
// the shell unaware of which page is showing — no top-level conditional
// has to know about every section.
// ProjectModal is a deep-link hint: when a user opens a project from a
// card's action icon (Edit / Invite / Delete), we want the detail page
// to pop the matching modal on mount so the user lands on the action
// they clicked, not just the project view.
export type ProjectModal = "edit" | "invite" | "delete";

// A project view can carry a deep-link from the persistent ProjectsNav:
// `path` jumps the Files browser to a folder, `preview` opens a clip in
// the review player. `seq` bumps on every navigation so the detail view
// re-applies the request even when the same folder/path is clicked twice.
type View =
  | { kind: "section"; section: Section }
  | {
      kind: "project";
      folderID: string;
      modal?: ProjectModal;
      path?: string;
      preview?: VideoPreviewFile;
      seq?: number;
    };

// View persistence: Stripe checkout navigates the WebView2 to Stripe
// and back, so the React app fully reloads. Without persistence the
// user always lands on Projects. Storing the last view in localStorage
// with a TTL lets us put them back where they were.
const LAST_VIEW_KEY = "vidsync.lastView";
const LAST_VIEW_TTL_MS = 10 * 60 * 1000;

function loadLastView(): View {
  const fallback: View = { kind: "section", section: "projects" };
  try {
    const raw = localStorage.getItem(LAST_VIEW_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { view: View; saved: number };
    if (!parsed || typeof parsed.saved !== "number") return fallback;
    if (Date.now() - parsed.saved > LAST_VIEW_TTL_MS) return fallback;
    return parsed.view;
  } catch {
    return fallback;
  }
}

function saveLastView(view: View): void {
  try {
    localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ view, saved: Date.now() }));
  } catch {
    // localStorage quota exceeded / disabled — silently skip.
  }
}

function AppShell() {
  // Restore the last view if it was saved within the past 10 minutes.
  // Stripe checkout / portal navigates the WebView2 itself, which
  // remounts the React app on return — without this restore the user
  // would always land on Projects after completing checkout. Anything
  // older than 10 minutes is treated as stale (the user came back to
  // the app another way) and we fall back to Projects.
  const [view, setView] = useState<View>(() => loadLastView());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [droppedPath, setDroppedPath] = useState<string | undefined>(undefined);
  const status = useSystemStatus();
  const myID = status.data?.myID ?? "";
  const folders = useConfig().data?.folders ?? [];
  // Monotonic nav counter: lets ProjectDetail re-apply a deep-link from
  // the ProjectsNav even when the target folder/path is unchanged.
  const navSeq = useRef(0);
  useDesktopNotifications();
  useInvitationNotifications(AUTH_ENABLED);
  useFsWatcherDelayMigration();
  useEntitlementEnforcement();

  // Persist view across navigations (e.g. the Stripe round-trip).
  // localStorage survives the WebView2's full reload from
  // wails.localhost/?checkout=... back into our index.html.
  useEffect(() => {
    saveLastView(view);
  }, [view]);

  // Wails drag-and-drop: a folder dropped onto the window opens
  // "Create project" with the path pre-filled. Listener is set up
  // once and only fires when the Wails runtime is present.
  useEffect(() => {
    const rt = (window as unknown as { runtime?: { EventsOn: (n: string, cb: (...args: unknown[]) => void) => () => void } }).runtime;
    if (!rt?.EventsOn) return;
    return rt.EventsOn("folder:dropped", (...args: unknown[]) => {
      const path = typeof args[0] === "string" ? args[0] : "";
      if (!path) return;
      setDroppedPath(path);
      setCreating(true);
    });
  }, []);

  const goToSection = (section: Section) => {
    bc(`nav:section ${section}`);
    setView({ kind: "section", section });
  };
  // goToProject is the single entry point for opening a project view.
  // Pages pass a `modal` (Edit/Invite/Delete deep-link); the ProjectsNav
  // passes `path` / `preview` to land on a folder or open a clip.
  const goToProject = (
    folderID: string,
    opts?: { modal?: ProjectModal } & OpenProjectOptions,
  ) => {
    navSeq.current += 1;
    bc(`nav:project ${folderID} modal=${opts?.modal ?? ""} path=${opts?.path ?? ""}`);
    setView({
      kind: "project",
      folderID,
      modal: opts?.modal,
      path: opts?.path,
      preview: opts?.preview,
      seq: navSeq.current,
    });
  };
  // Adapter matching the (folderID, modal?) signature the section router
  // and pages already call.
  const openProjectFromPage = (folderID: string, modal?: ProjectModal) =>
    goToProject(folderID, { modal });
  const backToProjects = () => {
    bc("nav:back");
    setView({ kind: "section", section: "projects" });
  };

  const activeSection: Section =
    view.kind === "section" ? view.section : "projects";

  // The projects navigator dock — reused by both the project workspace
  // (where ProjectDetail places it so the top bar can span across it) and
  // the section views.
  const projectsNavEl = (
    <ProjectsNav
      folders={folders}
      activeFolderID={view.kind === "project" ? view.folderID : null}
      allProjectsActive={view.kind === "section" && view.section === "projects"}
      onOpenAllProjects={() => goToSection("projects")}
      onOpenProject={(folderID, opts) => goToProject(folderID, opts)}
      onCreate={() => setCreating(true)}
    />
  );

  return (
    <div className="flex h-full gap-1.5 bg-base p-1.5 text-fg">
      {/* Auto-trusts collaborator devices in the background so project
          shares just start syncing — no manual device-connect prompt. */}
      <PendingDeviceAutoAccept />
      {/* In-app toast stack (new-comment notifications, etc.). */}
      <Toaster />
      <NavRail
        section={activeSection}
        onSection={goToSection}
        onOpenSettings={() => setSettingsOpen(true)}
        pendingCount={usePendingCount()}
        transferCount={useAllTransfers().length}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <OfflineBanner />
        <DaemonFatalBanner />
        <EntitlementBanner onOpenPricing={() => goToSection("billing")} />
        <div className="relative flex min-h-0 flex-1">
          {view.kind === "project" ? (
            <ProjectDetail
              key={view.folderID}
              folderID={view.folderID}
              initialModal={view.modal}
              navPath={view.path}
              navPreview={view.preview}
              navSeq={view.seq}
              projectsNav={projectsNavEl}
              onBack={backToProjects}
            />
          ) : (
            <div className="flex min-h-0 flex-1 gap-1.5">
              {projectsNavEl}
              {/* Section content dock. */}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel">
                <Suspense fallback={<SectionLoading />}>
                  <SectionRouter
                    section={view.section}
                    onOpenProject={openProjectFromPage}
                    onCreate={() => setCreating(true)}
                    onOpenBilling={
                      AUTH_ENABLED && !HIDE_BILLING
                        ? () => goToSection("billing")
                        : undefined
                    }
                  />
                </Suspense>
              </div>
            </div>
          )}
        </div>
        <TransferDock />
      </div>
      {/* Only mount the lazy modal trees once the user has actually
          asked for them; an unconditional render would fetch the
          chunk on first paint regardless of `open`. */}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
          />
        </Suspense>
      )}
      {creating && (
        <Suspense fallback={null}>
          <NewProjectModal
            open={creating}
            onClose={() => {
              setCreating(false);
              setDroppedPath(undefined);
            }}
            onCreated={openProjectFromPage}
            myID={myID}
            initialPath={droppedPath}
          />
        </Suspense>
      )}
    </div>
  );
}

// usePendingCount: sum of daemon-pending devices + daemon-pending
// folders + cloud-pending email invites, used to badge the Invitations
// sidebar entry.
//
// Two filters mirror the Invitations page so the badge doesn't flash
// during a sync handshake:
//   - pending devices whose deviceID matches an accepted cloud invite
//     are about to be added by the InvitationBridge — counting them
//     would surface a transient "1" that disappears seconds later.
//   - pending folder offers for folderIDs we already have configured
//     are spurious: owner-side they're the recipient re-advertising
//     during the addDevice→putFolder window, recipient-side they're
//     the owner re-advertising after we pre-added the folder. In
//     both cases there's nothing to "accept".
function usePendingCount(): number {
  const d = usePendingDevices();
  const f = usePendingFolders();
  const cfg = useConfig();
  const cloud = useMyInvitations(AUTH_ENABLED);
  const accepted = useAcceptedSince(null, AUTH_ENABLED);

  const bridgeDeviceIDs = new Set<string>();
  for (const inv of accepted.data?.invitations ?? []) {
    if (inv.recipientDeviceId) bridgeDeviceIDs.add(inv.recipientDeviceId);
  }
  const devices = Object.keys(d.data ?? {}).filter(
    (id) => !bridgeDeviceIDs.has(id),
  ).length;

  const ownedFolderIDs = new Set(
    (cfg.data?.folders ?? []).map((fc) => fc.id),
  );
  let folders = 0;
  for (const [folderID, pf] of Object.entries(f.data ?? {})) {
    if (ownedFolderIDs.has(folderID)) continue;
    folders += Object.keys(pf.offeredBy).length;
  }

  const cloudPending = (cloud.data?.invitations ?? []).filter(
    (i) => i.status === "pending",
  ).length;
  return devices + folders + cloudPending;
}

function SectionLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-fg-soft">Loading…</p>
    </div>
  );
}

function SectionRouter({
  section,
  onOpenProject,
  onCreate,
  onOpenBilling,
}: {
  section: Section;
  onOpenProject: (folderID: string, modal?: ProjectModal) => void;
  onCreate: () => void;
  onOpenBilling?: () => void;
}) {
  if (section === "projects") {
    return (
      <Projects
        onOpen={onOpenProject}
        onCreate={onCreate}
        onOpenBilling={onOpenBilling}
      />
    );
  }
  if (section === "transfers") {
    return <Transfers onOpenProject={onOpenProject} />;
  }
  if (section === "invitations")
    return <Invitations onOpenProject={onOpenProject} />;
  if (section === "activity") {
    // Activity itself doesn't know about the section router; clicking
    // a row should jump into the matching project's detail.
    return <Activity onOpen={(folderID) => onOpenProject(folderID)} />;
  }
  if (section === "billing" && AUTH_ENABLED && !HIDE_BILLING) return <Pricing />;
  return null;
}

