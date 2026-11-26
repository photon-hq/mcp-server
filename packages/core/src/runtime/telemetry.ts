import type { Capability } from "../release.js";
import type { Result } from "./execution/response.js";
import type { LifecycleDisposition } from "./execution/state.js";

export type ToolResult =
  | "complete"
  | "error"
  | "pending"
  | LifecycleDisposition;

export type RuntimeToolEvent =
  | Readonly<{
      capability: Capability;
      durationMs: number;
      input: unknown;
      kind: "completed";
      outcome: Result;
      result: ToolResult;
    }>
  | Readonly<{
      capability: Capability;
      durationMs: number;
      input: unknown;
      kind: "aborted";
    }>;

export type ToolObserver = (event: RuntimeToolEvent) => void;

export interface Telemetry {
  readonly event: (
    name: string,
    attributes: Readonly<Record<string, unknown>>,
    value?: number
  ) => void;
  readonly log: (
    name: string,
    attributes: Readonly<Record<string, unknown>>
  ) => void;
  readonly record: (
    event: Readonly<{
      durationMs?: number;
      name: string;
      result: string;
    }>
  ) => void;
  readonly span: <T>(
    name: string,
    attributes: Readonly<Record<string, unknown>>,
    callback: () => T | Promise<T>
  ) => Promise<T>;
}
