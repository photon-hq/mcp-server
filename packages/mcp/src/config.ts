export interface LocalConfig {
  readonly apiKey: string;
  readonly apiUrl: string;
}

const defaultApiUrl = "https://api.photon.codes";
const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
const bearerToken = /^[\x21-\x7e]{1,512}$/u;

// The key is sent as a bearer token to this origin, so a config file must not
// be able to point it elsewhere without an explicit opt-in.
function trustedHost(url: URL, allowCustom: boolean): boolean {
  return (
    allowCustom ||
    loopbackHosts.has(url.hostname) ||
    url.hostname === "photon.codes" ||
    url.hostname.endsWith(".photon.codes")
  );
}

function apiOrigin(value: string, allowCustom: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("PHOTON_API_URL must be an absolute URL.", {
      cause: error,
    });
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && loopbackHosts.has(url.hostname));
  if (
    !secure ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "PHOTON_API_URL must be an https origin with no path, query or credentials."
    );
  }
  if (!trustedHost(url, allowCustom)) {
    throw new Error(
      "PHOTON_API_URL must be a photon.codes or loopback origin; set PHOTON_ALLOW_CUSTOM_API_URL=1 to use another host."
    );
  }
  return url.origin;
}

export function loadLocalConfig(
  env: Readonly<Record<string, string | undefined>>
): LocalConfig {
  const apiKey = env.PHOTON_API_KEY ?? "";
  if (!bearerToken.test(apiKey)) {
    throw new Error(
      "Set PHOTON_API_KEY to a Photon Account Service Key (pho_ask_...)."
    );
  }
  return {
    apiKey,
    apiUrl: apiOrigin(
      env.PHOTON_API_URL || defaultApiUrl,
      env.PHOTON_ALLOW_CUSTOM_API_URL === "1"
    ),
  };
}
