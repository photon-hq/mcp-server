import { access } from "node:fs/promises";

try {
  await access(
    new URL("../dist/generated/runtime-release.js", import.meta.url)
  );
} catch (error) {
  throw new Error("Run `pnpm build` before publishing.", {
    cause: error,
  });
}
