export * from "@t3tools/shared/advertisedEndpoint";

/**
 * A server path on an environment. The base URL may carry a path prefix when a
 * proxy serves the environment below its origin root, e.g. `https://host/s/<id>`.
 */
export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
