import {
  Copy,
  KeyRound,
  Laptop,
  LogOut,
  Moon,
  RotateCw,
  Save,
  ShieldCheck,
  Sun,
} from "lucide-react"
import { useState, type ReactNode } from "react"

import type { DesktopSettings } from "../shared/contracts"
import type { ViewProps } from "./App"

import { Badge, Button, nextTabIndex } from "./components"
import { Github } from "./Github"

export function SettingsView({ snapshot, run, pending }: ViewProps) {
  const [draft, setDraft] = useState<DesktopSettings>(snapshot.settings)
  const [port, setPort] = useState(String(snapshot.settings.port))
  const portNumber = /^\d{1,5}$/.test(port) ? Number(port) : Number.NaN
  const validPort =
    Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535
  const nextSettings = { ...draft, port: portNumber }
  const dirty =
    !validPort
    || JSON.stringify(nextSettings) !== JSON.stringify(snapshot.settings)
  const signedIn = snapshot.account.kind === "signed-in"
  const patch = <K extends keyof DesktopSettings>(
    key: K,
    value: DesktopSettings[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  return (
    <div className="view-stack settings-view">
      <div className="view-heading">
        <div className="settings-title">
          <h2>Preferences</h2>
          {dirty && (
            <span
              className="unsaved-dot"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            />
          )}
        </div>
        <div className="button-group">
          {dirty && (
            <Button
              onClick={() => {
                setDraft(snapshot.settings)
                setPort(String(snapshot.settings.port))
              }}
            >
              Discard
            </Button>
          )}
          <Button
            data-testid="save-settings"
            form="settings-form"
            type="submit"
            variant="primary"
            icon={Save}
            disabled={!dirty || !validPort}
            busy={pending.has("save-settings")}
          >
            Save changes
          </Button>
        </div>
      </div>

      <form
        className="settings-stack"
        id="settings-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (validPort)
            void run(
              { kind: "save-settings", settings: nextSettings },
              "Settings saved",
            )
        }}
      >
        <GeneralSettings draft={draft} patch={patch} />

        <section className="panel settings-section">
          <div className="settings-section-heading">
            <h3>Gateway</h3>
          </div>
          <SettingRow
            label="Local port"
            htmlFor="gateway-port"
            description="The gateway uses 127.0.0.1 on this computer."
            control={
              <div className="port-control">
                <input
                  id="gateway-port"
                  data-testid="settings-port"
                  inputMode="numeric"
                  maxLength={5}
                  value={port}
                  aria-invalid={!validPort}
                  aria-describedby={!validPort ? "port-error" : undefined}
                  onChange={(event) => {
                    setPort(event.target.value)
                  }}
                />
                {!validPort && (
                  <span className="field-error" id="port-error" role="alert">
                    Use a port from 1024 to 65535.
                  </span>
                )}
              </div>
            }
          />
          <SettingRow
            label="Local API key"
            description="Rotating the key requires updating your connected agents."
            control={
              <div className="key-controls">
                <code
                  className="masked-key"
                  aria-label="Local API key is hidden"
                >
                  ••••••••••••
                </code>
                <Button
                  icon={Copy}
                  variant="ghost"
                  className="icon-button"
                  aria-label="Copy local API key"
                  title="Copy local API key"
                  disabled={!signedIn}
                  onClick={() => {
                    void run(
                      { kind: "copy", target: "gateway-key" },
                      "Local key copied",
                    )
                  }}
                />
                <Button
                  icon={RotateCw}
                  disabled={!signedIn}
                  busy={pending.has("rotate-key")}
                  onClick={() => {
                    void run(
                      { kind: "rotate-key" },
                      "Local key rotated. Update your agent configurations.",
                    )
                  }}
                >
                  Rotate key
                </Button>
              </div>
            }
          />
        </section>

        <section className="panel settings-section">
          <div className="settings-section-heading">
            <h3>GitHub Copilot</h3>
          </div>
          <div className="settings-account">
            <div className="settings-account-icon">
              <Github size={24} aria-hidden="true" />
            </div>
            <div>
              {snapshot.account.kind === "signed-in" ?
                <>
                  <strong>
                    {snapshot.account.name || snapshot.account.login}
                  </strong>
                  <span>
                    @{snapshot.account.login}
                    <Badge tone="success">
                      {snapshot.account.plan || "Connected"}
                    </Badge>
                  </span>
                </>
              : <>
                  <strong>No account connected</strong>
                  <span>Sign in with your Copilot subscription.</span>
                </>
              }
            </div>
            {signedIn ?
              <Button
                data-testid="sign-out"
                icon={LogOut}
                variant="ghost"
                busy={pending.has("sign-out")}
                onClick={() => {
                  void run({ kind: "sign-out" }, "Signed out")
                }}
              >
                Sign out
              </Button>
            : <Button
                icon={Github}
                busy={pending.has("sign-in")}
                onClick={() => {
                  void run({ kind: "sign-in" })
                }}
              >
                Sign in with GitHub
              </Button>
            }
          </div>
          <SettingRow
            label="Account type"
            htmlFor="account-type"
            control={
              <select
                id="account-type"
                value={draft.accountType}
                onChange={(event) => {
                  const value = event.target.value
                  if (
                    value === "individual"
                    || value === "business"
                    || value === "enterprise"
                  )
                    patch("accountType", value)
                }}
              >
                <option value="individual">Individual</option>
                <option value="business">Business</option>
                <option value="enterprise">Enterprise</option>
              </select>
            }
          />
          <div className="storage-summary">
            <ShieldCheck size={15} aria-hidden="true" />
            <span>
              {snapshot.storageMode === "encrypted" ?
                "Credentials are encrypted on this computer."
              : "Credentials are available for this session only."}
            </span>
          </div>
        </section>
      </form>
      <p className="footnote">
        <KeyRound size={13} aria-hidden="true" />
        Your GitHub token stays in the native app. Agents use a separate local
        key.
      </p>
    </div>
  )
}

function SettingRow({
  label,
  description,
  control,
  htmlFor,
}: {
  label: string
  description?: string
  control: ReactNode
  htmlFor?: string
}) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        {htmlFor ?
          <label htmlFor={htmlFor}>{label}</label>
        : <strong>{label}</strong>}
        {description && <p>{description}</p>}
      </div>
      <div className="setting-control">{control}</div>
    </div>
  )
}

function Switch({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className={`switch ${checked ? "is-on" : ""}`}
      onClick={() => {
        onChange(!checked)
      }}
    >
      <span />
    </button>
  )
}

function GeneralSettings({
  draft,
  patch,
}: {
  draft: DesktopSettings
  patch: <K extends keyof DesktopSettings>(
    key: K,
    value: DesktopSettings[K],
  ) => void
}) {
  const themes: Array<{
    value: DesktopSettings["theme"]
    label: string
    icon: typeof Sun
  }> = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Laptop },
  ]
  return (
    <section className="panel settings-section">
      <div className="settings-section-heading">
        <h3>General</h3>
      </div>
      <SettingRow
        label="Appearance"
        control={
          <div
            className="appearance-options"
            role="radiogroup"
            aria-label="Appearance"
          >
            {themes.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                id={`theme-${value}`}
                className={draft.theme === value ? "is-active" : undefined}
                type="button"
                role="radio"
                aria-checked={draft.theme === value}
                tabIndex={draft.theme === value ? 0 : -1}
                onClick={() => {
                  patch("theme", value)
                }}
                onKeyDown={(event) => {
                  const index = themes.findIndex(
                    (theme) => theme.value === draft.theme,
                  )
                  const nextIndex = nextTabIndex({
                    key: event.key,
                    index,
                    length: themes.length,
                  })
                  if (nextIndex === null) return
                  event.preventDefault()
                  const next = themes.at(nextIndex)
                  if (next) {
                    patch("theme", next.value)
                    document
                      .querySelector<HTMLElement>(`#theme-${next.value}`)
                      ?.focus()
                  }
                }}
              >
                <Icon size={15} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        }
      />
      <SettingRow
        label="Shell"
        htmlFor="settings-shell"
        control={
          <select
            id="settings-shell"
            value={draft.shell}
            onChange={(event) => {
              patch(
                "shell",
                event.target.value === "powershell" ? "powershell" : "posix",
              )
            }}
          >
            <option value="posix">POSIX shell</option>
            <option value="powershell">PowerShell</option>
          </select>
        }
      />
      <SettingRow
        label="Open at login"
        htmlFor="launch-at-login"
        control={
          <Switch
            id="launch-at-login"
            label="Open at login"
            checked={draft.launchAtLogin}
            onChange={(value) => {
              patch("launchAtLogin", value)
            }}
          />
        }
      />
      <SettingRow
        label="Start gateway on launch"
        htmlFor="start-on-launch"
        control={
          <Switch
            id="start-on-launch"
            label="Start gateway on launch"
            checked={draft.startOnLaunch}
            onChange={(value) => {
              patch("startOnLaunch", value)
            }}
          />
        }
      />
      <SettingRow
        label="Keep running when closed"
        description="Keep the gateway in the menu bar or system tray."
        htmlFor="close-to-tray"
        control={
          <Switch
            id="close-to-tray"
            label="Keep running when closed"
            checked={draft.closeToTray}
            onChange={(value) => {
              patch("closeToTray", value)
            }}
          />
        }
      />
    </section>
  )
}
