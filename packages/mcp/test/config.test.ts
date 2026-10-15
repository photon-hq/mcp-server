import { describe, expect, it } from "vitest";
import { loadLocalConfig } from "../src/config.js";

describe("loadLocalConfig", () => {
  it("defaults to the production API", () => {
    expect(loadLocalConfig({ PHOTON_API_KEY: "pho_ask_key_secret" })).toEqual({
      apiKey: "pho_ask_key_secret",
      apiUrl: "https://api.photon.codes",
    });
  });

  it("accepts an https origin or a loopback http origin", () => {
    expect(
      loadLocalConfig({
        PHOTON_API_KEY: "key",
        PHOTON_API_URL: "https://api.example.com/",
      }).apiUrl
    ).toBe("https://api.example.com");
    expect(
      loadLocalConfig({
        PHOTON_API_KEY: "key",
        PHOTON_API_URL: "http://127.0.0.1:8787",
      }).apiUrl
    ).toBe("http://127.0.0.1:8787");
  });

  it.each([
    {},
    { PHOTON_API_KEY: "" },
    { PHOTON_API_KEY: "has space" },
    { PHOTON_API_KEY: "x".repeat(513) },
  ])("rejects a missing or malformed key %#", (env) => {
    expect(() => loadLocalConfig(env)).toThrow("PHOTON_API_KEY");
  });

  it.each([
    "api.photon.codes",
    "http://api.photon.codes",
    "https://api.photon.codes/v1",
    "https://api.photon.codes/?a=1",
    "https://user:pass@api.photon.codes",
  ])("rejects API URL %s", (value) => {
    expect(() =>
      loadLocalConfig({ PHOTON_API_KEY: "key", PHOTON_API_URL: value })
    ).toThrow("PHOTON_API_URL");
  });
});
