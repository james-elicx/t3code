import type { S3MountRequest } from "@cloudflare/sandbox";

import type { ControlPlaneExports, Env } from "./env.ts";

/** Where every sandbox reads the shared bucket's skills and memories. */
export const SHARED_PATH = "/shared";

const ROUTE_HOST = /^s3-([A-Za-z0-9-]+)\.sandbox\.internal$/;

/** The shared bucket's read-only mount, or null without an endpoint and keys. */
export function sharedMount(env: Env): S3MountRequest | null {
  const { SHARED_S3_ENDPOINT, SHARED_S3_ACCESS_KEY_ID, SHARED_S3_SECRET_ACCESS_KEY } = env;
  if (!SHARED_S3_ENDPOINT || !SHARED_S3_ACCESS_KEY_ID || !SHARED_S3_SECRET_ACCESS_KEY) return null;
  return {
    mountPath: SHARED_PATH,
    source: {
      type: "s3",
      endpoint: SHARED_S3_ENDPOINT,
      region: env.SHARED_S3_REGION,
      bucket: env.SHARED_BUCKET,
      credentials: {
        type: "static",
        accessKeyId: SHARED_S3_ACCESS_KEY_ID,
        secretAccessKey: SHARED_S3_SECRET_ACCESS_KEY,
      },
    },
    access: "read-only",
  };
}

/**
 * The S3 gateway for an s3fs request to the shared mount's route, or null for
 * any other host. S3Mount registers each route after the catch-all egress
 * intercept, which takes it, and a restarted Durable Object registers only the
 * catch-all again; so egress hands the route to the gateway itself.
 */
export function sharedGateway(env: Env, exports: ControlPlaneExports, hostname: string) {
  const routeId = ROUTE_HOST.exec(hostname)?.[1];
  const mount = routeId ? sharedMount(env) : null;
  if (!routeId || !mount) return null;
  return exports.S3Gateway({
    props: {
      protocolVersion: 1,
      mode: "active",
      routeId,
      source: mount.source,
      access: "read-only",
    },
  });
}
