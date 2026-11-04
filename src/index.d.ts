import type { Component, ComponentType, ReactNode } from "react"

export interface LoggerAIStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export interface Options {
  /** The project's public key (pk_live_...). Safe to ship in the app. Never the secret key. */
  publicKey: string
  endpoint?: string
  /** Names the app in LoggerAI, e.g. "mobile". */
  service?: string
  environment?: string
  /** Your app's version or build, so LoggerAI can say "since release X". */
  release?: string
  /** Hosts of your own API. Calls to them carry traceparent and x-loggerai-session. */
  traceHosts?: string[]
  /** Parts of a stack frame's path that mark your own code. By default, all but libraries. */
  appPaths?: string[]
  /** Record calls made with fetch, axios and XMLHttpRequest. */
  captureNetwork?: boolean
  /** How often to send, in milliseconds. */
  flushInterval?: number
  /** After this long in the background (milliseconds), coming back starts a new session. */
  sessionTimeout?: number
  enabled?: boolean
  /** Where reports go; by default the ingest endpoint with /report instead of /batch. */
  reportEndpoint?: string
  /** Which network calls carry their headers and bodies. By default, failed ones. */
  networkDetails?: "none" | "failures" | "all"
  maxBodyBytes?: number
  /** More field names to mask in network calls and events. */
  maskKeys?: string[]
  /** AsyncStorage or similar: keeps crashes across a restart, and this device's reports. */
  storage?: LoggerAIStorage
  /** Returns a file URI for a picture of the screen, e.g. react-native-view-shot's captureScreen. */
  captureScreen?: () => Promise<string>
}

export interface MyReport {
  id: number
  title: string
  status: "open" | "investigating" | "resolved" | string
  createdAt: string
  updatedAt: string | null
  resolvedAt: string | null
}

export class LoggerAIReportError extends Error {}

export function init(options: Options): boolean
export function close(): void
export function isStarted(): boolean
export function sessionId(): string | null
export function captureException(error: unknown, context?: Record<string, unknown>): void
export function track(name: string, data?: Record<string, unknown>): void
export function setUser(id: string | number | null, options?: { hash?: string }): void
export function setScreen(name: string): void
export function trackNavigation(ref: { getCurrentRoute(): { name: string } | undefined; addListener(type: "state", fn: () => void): () => void }): () => void
export function flush(): Promise<void>
export function report(note: string, options?: { screenshots?: string[]; contact?: string; extra?: Record<string, unknown> }): Promise<number>
export function myReports(): Promise<MyReport[]>
export function useScreen(name: string): void

export class ErrorBoundary extends Component<{ children?: ReactNode; fallback?: ReactNode | ((p: { error: unknown; reset: () => void }) => ReactNode) }> {}
export const ReportSheet: ComponentType<{ visible: boolean; onClose: () => void; title?: string; hint?: string; askContact?: boolean; color?: string; dark?: boolean; showMyReports?: boolean }>
export const MyReportsSheet: ComponentType<{ visible: boolean; onClose: () => void; title?: string; color?: string; dark?: boolean }>
