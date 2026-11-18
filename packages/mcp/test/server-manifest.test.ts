import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly mcpName?: string;
  readonly name: string;
  readonly version: string;
}

interface ServerManifest {
  readonly $schema: string;
  readonly description: string;
  readonly name: string;
  readonly packages: readonly {
    readonly environmentVariables?: readonly {
      readonly isRequired?: boolean;
      readonly isSecret?: boolean;
      readonly name: string;
    }[];
    readonly identifier: string;
    readonly registryType: string;
    readonly transport: { readonly type: string };
    readonly version: string;
  }[];
  readonly remotes: readonly {
    readonly type: string;
    readonly url: string;
  }[];
  readonly repository: {
    readonly source: string;
    readonly subfolder: string;
    readonly url: string;
  };
  readonly title: string;
  readonly version: string;
  readonly websiteUrl: string;
}

async function readJson<T>(relativePath: string): Promise<T> {
  const content = await readFile(
    new URL(relativePath, import.meta.url),
    "utf8"
  );
  return JSON.parse(content) as T;
}

describe("Official MCP Registry manifest", () => {
  it("keeps server.json aligned with package.json and remote MCP endpoint", async () => {
    const pkg = await readJson<PackageManifest>("../package.json");
    const server = await readJson<ServerManifest>("../server.json");

    expect(pkg.mcpName).toBe("io.github.photon-hq/mcp");
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.remotes).toEqual([
      {
        type: "streamable-http",
        url: "https://mcp.photon.codes/mcp",
      },
    ]);
    expect(server.packages).toEqual([
      {
        environmentVariables: [
          {
            description: "Your Photon Account Service Key",
            isRequired: true,
            isSecret: true,
            name: "PHOTON_API_KEY",
          },
        ],
        identifier: pkg.name,
        registryType: "npm",
        transport: { type: "stdio" },
        version: pkg.version,
      },
    ]);
  });
});
