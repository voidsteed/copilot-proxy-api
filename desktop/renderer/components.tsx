import { LoaderCircle, X, type LucideIcon } from "lucide-react"
import {
  useEffect,
  useId,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react"

import type { DesktopModel, DesktopSnapshot } from "../shared/contracts"

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger"
  icon?: LucideIcon
  busy?: boolean
}

export function Button({
  variant = "secondary",
  icon: Icon,
  busy = false,
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  const DisplayIcon = busy ? LoaderCircle : Icon
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`button button-${variant} ${className}`}
    >
      {DisplayIcon && (
        <DisplayIcon
          size={15}
          strokeWidth={1.8}
          aria-hidden="true"
          className={busy ? "spin" : undefined}
        />
      )}
      {children}
    </button>
  )
}

export type BadgeTone = "neutral" | "success" | "warning" | "error"

export function Badge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode
  tone?: BadgeTone
  dot?: boolean
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <span className="status-dot" />}
      {children}
    </span>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={23} strokeWidth={1.5} aria-hidden="true" />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function Dialog({
  title,
  children,
  onClose,
  footer,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
}) {
  const titleId = useId()
  const container = useRef<HTMLDivElement>(null)
  const closeHandler = useRef(onClose)
  closeHandler.current = onClose

  useEffect(() => {
    const previousFocus = document.activeElement
    const element = container.current
    element?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        closeHandler.current()
      }
      if (event.key !== "Tab" || !element) return
      const focusable = Array.from(
        element.querySelectorAll<HTMLElement>(
          "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((control) => control.getClientRects().length > 0)
      const first = focusable.at(0)
      const last = focusable.at(-1)
      if (!first || !last) {
        event.preventDefault()
        element.focus()
      } else if (
        event.shiftKey
        && (document.activeElement === first
          || document.activeElement === element)
      ) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey
        && (document.activeElement === last
          || document.activeElement === element)
      ) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus()
      else document.querySelector<HTMLElement>("[aria-current='page']")?.focus()
    }
  }, [])

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeHandler.current()
      }}
    >
      <div
        ref={container}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <Button
            variant="ghost"
            icon={X}
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          />
        </div>
        <div className="dialog-content">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  )
}

const numberFormatter = new Intl.NumberFormat(undefined)
const compactFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})

export function formatNumber(value: number): string {
  return numberFormatter.format(value)
}

export function formatLimit(value: number | null): string {
  return value === null ? "Unknown" : (
      compactFormatter.format(value).toLowerCase()
    )
}

export function formatTokens(value: number | null): string {
  return value === null ? "n/a" : formatNumber(value)
}

export function formatDuration(value: number): string {
  return value < 1000 ?
      `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(1)} s`
}

export function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Unknown" : (
      date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    )
}

export function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Unknown" : (
      date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    )
}

export function gatewayStatus(gateway: DesktopSnapshot["gateway"]): {
  label: string
  tone: BadgeTone
} {
  switch (gateway.kind) {
    case "running": {
      return { label: "Running", tone: "success" }
    }
    case "starting": {
      return { label: "Starting", tone: "warning" }
    }
    case "stopping": {
      return { label: "Stopping", tone: "warning" }
    }
    case "error": {
      return { label: "Needs attention", tone: "error" }
    }
    case "stopped": {
      return { label: "Stopped", tone: "neutral" }
    }
    default: {
      const exhaustive: never = gateway
      return exhaustive
    }
  }
}

export function nextTabIndex({
  key,
  index,
  length,
}: {
  key: string
  index: number
  length: number
}): number | null {
  if (length === 0) return null
  switch (key) {
    case "Home": {
      return 0
    }
    case "End": {
      return length - 1
    }
    case "ArrowRight":
    case "ArrowDown": {
      return (index + 1) % length
    }
    case "ArrowLeft":
    case "ArrowUp": {
      return (index - 1 + length) % length
    }
    default: {
      return null
    }
  }
}

export function ModelSelect({
  models,
  value,
  onChange,
  disabled,
  id = "model-select",
  label = "Model",
}: {
  models: Array<DesktopModel>
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  id?: string
  label?: string
}) {
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
        }}
        disabled={disabled || models.length === 0}
      >
        {models.length === 0 && <option value="">No models available</option>}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </label>
  )
}
