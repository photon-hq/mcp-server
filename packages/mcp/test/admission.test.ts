import { describe, expect, it } from "vitest";
import { restrictToOauthScopes } from "../src/admission.js";

const operation = (permissions?: readonly string[]) => ({
  operationId: "op",
  ...(permissions === undefined
    ? {}
    : { "x-required-permissions": permissions }),
});

describe("restrictToOauthScopes", () => {
  it("keeps operations whose every permission is an OAuth scope", () => {
    const { aggregate, excluded } = restrictToOauthScopes(
      {
        openapi: "3.1.0",
        paths: {
          "/v1/projects/{id}": {
            get: operation(["project:read"]),
            parameters: [],
            patch: operation(["project:read", "project:write"]),
          },
        },
      },
      ["project:read", "project:write"]
    );
    expect(excluded).toEqual([]);
    expect(aggregate.paths).toEqual({
      "/v1/projects/{id}": {
        get: operation(["project:read"]),
        parameters: [],
        patch: operation(["project:read", "project:write"]),
      },
    });
  });

  it("disables first-party, unlisted and unannotated operations", () => {
    const { aggregate, excluded } = restrictToOauthScopes(
      {
        paths: {
          "/v1/account": { delete: operation(["security:write"]) },
          "/v1/account/security/mfa": { get: operation() },
          "/v1/projects/{id}/api-keys": {
            post: operation(["project:read", "project:manage_api_keys"]),
          },
          "/v1/status": { get: operation([]) },
        },
      },
      ["project:read"]
    );
    expect(excluded).toEqual([
      "DELETE /v1/account",
      "GET /v1/account/security/mfa",
      "POST /v1/projects/{id}/api-keys",
      "GET /v1/status",
    ]);
    expect(aggregate.paths).toMatchObject({
      "/v1/account": { delete: { "x-photon-mcp": { enabled: false } } },
      "/v1/projects/{id}/api-keys": {
        post: {
          "x-required-permissions": ["project:read", "project:manage_api_keys"],
        },
      },
    });
  });

  it("disables secret operations even within OAuth scopes", () => {
    const path =
      "/v1/projects/{projectId}/webhooks/destinations/{destinationId}/secret-rotations";
    const { excluded } = restrictToOauthScopes(
      {
        paths: {
          [path]: {
            post: {
              ...operation(["project:write"]),
              operationId: "rotateWebhookSigningSecret",
            },
          },
        },
      },
      ["project:write"]
    );
    expect(excluded).toEqual([`POST ${path}`]);
  });

  it("overrides producer MCP options when excluding", () => {
    const { aggregate } = restrictToOauthScopes(
      {
        paths: {
          "/v1/account": {
            delete: {
              ...operation(["security:write"]),
              "x-photon-mcp": { destructive: true },
            },
          },
        },
      },
      []
    );
    expect(aggregate.paths).toEqual({
      "/v1/account": {
        delete: {
          ...operation(["security:write"]),
          "x-photon-mcp": { enabled: false },
        },
      },
    });
  });

  it("disables operations whose security refuses an API key", () => {
    const { excluded } = restrictToOauthScopes(
      {
        paths: {
          "/v1/organizations/{organizationId}/members": {
            get: {
              ...operation(["organization:read"]),
              security: [
                { accountServiceKey: [] },
                { oauth2: ["organization:read"] },
              ],
            },
          },
          "/v1/organizations/current": {
            get: {
              ...operation(["organization:read"]),
              operationId: "getCurrentOrganization",
              security: [
                { serviceIdentityBearer: [] },
                { oauth2: ["organization:read"] },
              ],
            },
          },
        },
      },
      ["organization:read"]
    );
    expect(excluded).toEqual(["GET /v1/organizations/current"]);
  });

  it("enables account-key operations outside OAuth scopes", () => {
    const listOrganizations = {
      ...operation(["account:read_organizations"]),
      operationId: "listOrganizations",
      security: [{ accountServiceKey: [] }],
      "x-photon-mcp": { enabled: false },
    };
    const { aggregate, excluded } = restrictToOauthScopes(
      { paths: { "/v1/organizations": { get: listOrganizations } } },
      ["organization:read"]
    );
    expect(excluded).toEqual([]);
    expect(aggregate.paths).toEqual({
      "/v1/organizations": {
        get: { ...listOrganizations, "x-photon-mcp": { enabled: true } },
      },
    });
  });
});
