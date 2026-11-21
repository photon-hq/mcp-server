// The Photon API version the catalog is fetched at and every release pins.
import { readFile } from "node:fs/promises";

export async function readApiVersion() {
  const { version } = JSON.parse(
    await readFile(
      new URL("../catalog/api-version.json", import.meta.url),
      "utf8"
    )
  );
  if (typeof version !== "string" || !version || version.trim() !== version) {
    throw new Error(
      "catalog/api-version.json must contain a version string without surrounding whitespace."
    );
  }
  return version;
}
