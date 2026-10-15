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
