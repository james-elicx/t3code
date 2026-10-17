import type { S3GatewayBinding } from "@cloudflare/sandbox";
import { describe, expect, it } from "vite-plus/test";

import type { ControlPlaneExports, Env } from "./env.ts";
import { sharedGateway, sharedMount } from "./sharedMount.ts";

const env = {
  SHARED_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  SHARED_S3_REGION: "auto",
  SHARED_BUCKET: "t3-sandbox-control-shared",
  SHARED_S3_ACCESS_KEY_ID: "key-id",
  SHARED_S3_SECRET_ACCESS_KEY: "secret",
} as Env;

function gatewayExports() {
  const props: Array<Parameters<S3GatewayBinding>[0]["props"]> = [];
  const S3Gateway: S3GatewayBinding = (options) => {
    props.push(options.props);
    return {} as Fetcher;
  };
  return { exports: { S3Gateway } as ControlPlaneExports, props };
}

describe("sharedMount", () => {
  it("mounts the bucket read-only at /shared", () => {
    expect(sharedMount(env)).toMatchObject({
      mountPath: "/shared",
      access: "read-only",
      source: { bucket: "t3-sandbox-control-shared", credentials: { accessKeyId: "key-id" } },
    });
  });

  it("is skipped without an endpoint or either key", () => {
    expect(sharedMount({ ...env, SHARED_S3_ENDPOINT: "" })).toBeNull();
    expect(
      sharedMount({ ...env, SHARED_S3_ACCESS_KEY_ID: undefined } as unknown as Env),
    ).toBeNull();
    expect(sharedMount({ ...env, SHARED_S3_SECRET_ACCESS_KEY: "" })).toBeNull();
  });
});

describe("sharedGateway", () => {
  it("routes an s3fs route host to the gateway, read-only, with the mount's source", () => {
    const { exports, props } = gatewayExports();
    expect(sharedGateway(env, exports, "s3-0b5ac3ae-1caf-4c71.sandbox.internal")).not.toBeNull();
    expect(props).toEqual([
      {
        protocolVersion: 1,
        mode: "active",
        routeId: "0b5ac3ae-1caf-4c71",
        source: sharedMount(env)!.source,
        access: "read-only",
      },
    ]);
  });

  it("leaves other hosts to egress, and every host when there is no mount", () => {
    const { exports, props } = gatewayExports();
    expect(sharedGateway(env, exports, "example.com")).toBeNull();
    expect(sharedGateway(env, exports, "s3-x.sandbox.internal.example.com")).toBeNull();
    expect(
      sharedGateway({ ...env, SHARED_S3_ENDPOINT: "" }, exports, "s3-abc.sandbox.internal"),
    ).toBeNull();
    expect(props).toEqual([]);
  });
});
