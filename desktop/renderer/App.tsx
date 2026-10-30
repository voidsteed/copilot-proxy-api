import {
  Activity,
  Box,
  Check,
  ChevronRight,
  Copy,
  LayoutDashboard,
  LoaderCircle,
  LogIn,
  Network,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react"
import { useEffect, useState } from "react"

import type { DesktopCommand, DesktopSnapshot } from "../shared/contracts"

import { ActivityView } from "./ActivityView"
import { AgentsView } from "./AgentsView"
import { useDesktop, type RunCommand } from "./bridge"
import { Badge, Button, Dialog, EmptyState, gatewayStatus } from "./components"
import { Github } from "./Github"
import { ModelsView } from "./ModelsView"
import { OverviewView } from "./OverviewView"
import { SettingsView } from "./SettingsView"

type View = "overview" | "models" | "agents" | "activity" | "settings"

const navigation: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "models", label: "Models", icon: Box },
  { id: "agents", label: "Agents", icon: Terminal },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings2 },
]

export type PendingCommands = ReadonlySet<DesktopCommand["kind"]>

export interface ViewProps {
  snapshot: DesktopSnapshot
  run: RunCommand
  pending: PendingCommands
}

export function App() {
  const desktop = useDesktop()
  const [view, setView] = useState<View>("overview")
  const [testRequest, setTestRequest] = useState<{
    open: boolean
    modelId: string
  }>({ open: false, modelId: "" })
  const snapshot =
    desktop.state.kind === "ready" ? desktop.state.snapshot : null

  useEffect(() => {
    const theme = snapshot?.settings.theme ?? "light"
    const media = globalThis.matchMedia("(prefers-color-scheme: dark)")
    const applyTheme = () => {
      const systemTheme = media.matches ? "dark" : "light"
      document.documentElement.dataset.theme =
        theme === "system" ? systemTheme : theme
    }
    applyTheme()
    media.addEventListener("change", applyTheme)
    return () => {
      media.removeEventListener("change", applyTheme)
    }
  }, [snapshot?.settings.theme])

  const status = snapshot ? gatewayStatus(snapshot.gateway) : null
  const signedIn = snapshot?.account.kind === "signed-in"
  const account = snapshot?.account
  const signInBusy =
    account?.kind === "connecting"
    || account?.kind === "awaiting-authorization"
    || desktop.pending.has("sign-in")

  const openTest = (modelId = "") => {
    setTestRequest({ open: true, modelId })
    setView("overview")
  }

  return (
    <div
      className={`app-shell ${snapshot?.platform === "darwin" && globalThis.copilotBridge ? "native-mac" : ""}`}
    >
      <Sidebar
        snapshot={snapshot}
        view={view}
        onNavigate={setView}
        signInBusy={signInBusy}
        run={desktop.run}
      />

      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <h1>{navigation.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="topbar-actions">
            {status && (
              <Badge tone={status.tone} dot>
                Gateway {status.label.toLowerCase()}
              </Badge>
            )}
            {signedIn ?
              <Button
                icon={RefreshCw}
                variant="ghost"
                className="icon-button"
                aria-label="Refresh account and models"
                title="Refresh account and models"
                busy={desktop.pending.has("refresh")}
                onClick={() => {
                  void desktop.run({ kind: "refresh" })
                }}
              />
            : <Button
                data-testid="sign-in"
                icon={Github}
                aria-label="Sign in with GitHub"
                disabled={!snapshot || signInBusy}
                busy={desktop.pending.has("sign-in")}
                onClick={() => {
                  void desktop.run({ kind: "sign-in" })
                }}
              >
                Sign in
              </Button>
            }
          </div>
        </header>

        <main className="main-scroll" id="main-content">
          <div className="main-content">
            {snapshot?.fixture && (
              <div className="fixture-banner" role="note">
                <TriangleAlert size={15} aria-hidden="true" />
                <strong>Fixture mode</strong>
                <span>
                  Local test services. Account, model, and usage data are
                  fixtures.
                </span>
              </div>
            )}
            {snapshot?.storageMode === "session-only" && (
              <div className="notice notice-warning">
                <ShieldCheck size={17} aria-hidden="true" />
                <p>
                  Credentials are kept for this session. Secure storage is
                  unavailable, so you will need to sign in again after quitting.
                </p>
              </div>
            )}
            {desktop.connectionError && (
              <div className="notice notice-warning" role="status">
                <RefreshCw size={17} aria-hidden="true" />
                <p>{desktop.connectionError}</p>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void desktop.refreshSnapshot()
                  }}
                >
                  Retry
                </Button>
              </div>
            )}
            {desktop.actionError && (
              <div className="notice notice-error" role="alert">
                <TriangleAlert size={17} aria-hidden="true" />
                <p>{desktop.actionError}</p>
                <Button
                  icon={X}
                  variant="ghost"
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={desktop.dismissError}
                />
              </div>
            )}
            {snapshot?.notice && (
              <div
                className={`notice notice-${snapshot.notice.kind === "error" ? "error" : "info"}`}
                role={snapshot.notice.kind === "error" ? "alert" : "status"}
              >
                <TriangleAlert size={17} aria-hidden="true" />
                <p>{snapshot.notice.message}</p>
                <Button
                  icon={X}
                  variant="ghost"
                  className="icon-button"
                  aria-label="Dismiss notification"
                  onClick={() => {
                    void desktop.run({ kind: "dismiss-notice" })
                  }}
                />
              </div>
            )}
            {account?.kind === "error" && (
              <div className="notice notice-error" role="alert">
                <Github size={18} aria-hidden="true" />
                <p>{account.message}</p>
                <Button
                  onClick={() => {
                    void desktop.run({ kind: "sign-in" })
                  }}
                  busy={desktop.pending.has("sign-in")}
                >
                  Try sign-in again
                </Button>
              </div>
            )}

            {desktop.state.kind === "loading" && (
              <div className="app-loading" role="status">
                <LoaderCircle className="spin" size={24} strokeWidth={1.5} />
                <p>Connecting to Copilot Bridge…</p>
              </div>
            )}
            {desktop.state.kind === "unavailable" && (
              <EmptyState
                icon={Network}
                title="Copilot Bridge is unavailable"
                action={
                  <Button
                    icon={RefreshCw}
                    onClick={() => {
                      void desktop.refreshSnapshot()
                    }}
                  >
                    Try again
                  </Button>
                }
              >
                {desktop.state.message}
              </EmptyState>
            )}
            {snapshot && (
              <>
                {view === "overview" && (
                  <OverviewView
                    snapshot={snapshot}
                    run={desktop.run}
                    pending={desktop.pending}
                    testRequest={testRequest}
                    onTestToggle={(open) => {
                      setTestRequest((current) => ({ ...current, open }))
                    }}
                    onNavigate={setView}
                  />
                )}
                {view === "models" && (
                  <ModelsView
                    snapshot={snapshot}
                    run={desktop.run}
                    pending={desktop.pending}
                    onSetUp={() => {
                      setView("agents")
                    }}
                    onProbe={openTest}
                  />
                )}
                {view === "agents" && (
                  <AgentsView
                    snapshot={snapshot}
                    run={desktop.run}
                    pending={desktop.pending}
                  />
                )}
                {view === "activity" && (
                  <ActivityView
                    snapshot={snapshot}
                    run={desktop.run}
                    pending={desktop.pending}
                    onTest={() => {
                      openTest()
                    }}
                  />
                )}
                {view === "settings" && (
                  <SettingsView
                    snapshot={snapshot}
                    run={desktop.run}
                    pending={desktop.pending}
                  />
                )}
              </>
            )}
          </div>
        </main>
      </div>

      {desktop.confirmation && (
        <div className="toast" role="status">
          <Check size={16} aria-hidden="true" />
          {desktop.confirmation}
        </div>
      )}
      {snapshot
        && (snapshot.account.kind === "connecting"
          || snapshot.account.kind === "awaiting-authorization") && (
          <SignInDialog
            snapshot={snapshot}
            run={desktop.run}
            pending={desktop.pending}
          />
        )}
    </div>
  )
}

function SignInDialog({ snapshot, run, pending }: ViewProps) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      globalThis.clearInterval(timer)
    }
  }, [])
  const account = snapshot.account
  const cancel = () => {
    void run({ kind: "cancel-sign-in" })
  }
  if (
    account.kind !== "connecting"
    && account.kind !== "awaiting-authorization"
  )
    return null
  const remaining =
    account.kind === "awaiting-authorization" ?
      Math.max(0, Math.ceil((Date.parse(account.expiresAt) - now) / 1000))
    : 0
  const expired = account.kind === "awaiting-authorization" && remaining <= 0

  return (
    <Dialog
      title="Sign in with GitHub"
      onClose={cancel}
      footer={
        <>
          <Button
            data-testid="cancel-sign-in"
            onClick={cancel}
            busy={pending.has("cancel-sign-in")}
          >
            Cancel
          </Button>
          {account.kind === "awaiting-authorization" && (
            <Button
              variant="primary"
              icon={Github}
              disabled={expired}
              busy={pending.has("open-device-page")}
              onClick={() => {
                void run({ kind: "open-device-page" })
              }}
            >
              Open GitHub
            </Button>
          )}
        </>
      }
    >
      <div className="sign-in-icon">
        <Github size={29} strokeWidth={1.6} aria-hidden="true" />
      </div>
      {account.kind === "connecting" ?
        <div className="connecting-state" role="status">
          <LoaderCircle size={21} className="spin" />
          <p>Requesting your device code…</p>
        </div>
      : <>
          <p className="dialog-intro">
            Enter this code on GitHub to connect your Copilot account.
          </p>
          <div className="device-code">{account.code}</div>
          <Button
            className="copy-device-code"
            icon={Copy}
            disabled={expired}
            onClick={() => {
              void run(
                { kind: "copy", target: "device-code" },
                "Device code copied",
              )
            }}
          >
            Copy code
          </Button>
          <div
            className={`authorization-status ${expired ? "is-expired" : ""}`}
            role="status"
          >
            {!expired && (
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
            )}
            <span>
              {expired ?
                "Code expired. Cancel and sign in again."
              : "Waiting for approval on GitHub"}
            </span>
          </div>
          {!expired && (
            <p className="expiry">
              Expires in {Math.floor(remaining / 60)}:
              {String(remaining % 60).padStart(2, "0")}
            </p>
          )}
        </>
      }
    </Dialog>
  )
}

function Sidebar({
  snapshot,
  view,
  onNavigate,
  signInBusy,
  run,
}: {
  snapshot: DesktopSnapshot | null
  view: View
  onNavigate: (view: View) => void
  signInBusy: boolean
  run: RunCommand
}) {
  const account = snapshot?.account
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark" aria-hidden="true">
          <Network size={20} strokeWidth={1.9} />
        </div>
        <div className="brand-name">
          Copilot Bridge<span>Local gateway</span>
        </div>
      </div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {navigation.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            data-testid={`nav-${id}`}
            aria-label={label}
            className={`nav-item ${view === id ? "is-active" : ""}`}
            aria-current={view === id ? "page" : undefined}
            onClick={() => {
              onNavigate(id)
            }}
          >
            <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
            <span>{label}</span>
            {id === "models" && snapshot && snapshot.models.length > 0 && (
              <span className="nav-count">{snapshot.models.length}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        {account?.kind === "signed-in" ?
          <button
            className="account-switch"
            type="button"
            aria-label={`Account settings for ${account.login}`}
            onClick={() => {
              onNavigate("settings")
            }}
          >
            <div className="account-avatar">
              {account.login.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <strong>{account.login}</strong>
              <span>{account.plan || "GitHub Copilot"}</span>
            </div>
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        : <button
            className="account-switch"
            type="button"
            aria-label="Sign in with GitHub"
            disabled={!snapshot || signInBusy}
            onClick={() => {
              void run({ kind: "sign-in" })
            }}
          >
            <div className="account-avatar">
              <Github size={17} aria-hidden="true" />
            </div>
            <div>
              <strong>{signInBusy ? "Connecting…" : "Sign in"}</strong>
              <span>GitHub Copilot</span>
            </div>
            <LogIn size={14} aria-hidden="true" />
          </button>
        }
        <div className="sidebar-version">
          <span className="version-dot" />
          Copilot Bridge {snapshot?.version ?? ""}
        </div>
      </div>
    </aside>
  )
}
