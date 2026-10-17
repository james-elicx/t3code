import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Etag, HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunchHttp from "./launchHttp.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

class LaunchApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.threadLaunch) {}

const launchBody = {
  commandId: "command-1",
  threadId: "thread-from-client",
  projectId: "sandbox:acme/demo",
  title: "Fix the build",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  initialMessage: { messageId: "message-1", text: "Fix the build", attachments: [] },
};

function serve(scopes: ReadonlyArray<AuthEnvironmentScope>) {
  const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("control-plane"),
        subject: "control-plane",
        method: "bearer-access-token",
        scopes: new Set(scopes),
      }),
    ),
  );
  const services = Layer.mergeAll(
    Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, {
      awaitCommandReady: Effect.void,
      markHttpListening: Effect.void,
      enqueueCommand: (effect) => effect,
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) => {
        launched.push(input);
        return Effect.succeed({
          threadId: input.threadId ?? ThreadId.make("generated"),
          projection: {} as OrchestrationV2ThreadProjection,
          resumed: false,
        });
      },
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    Layer.mock(ServerSettings.ServerSettingsService)({}),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-launch-http-test-" }),
  );
  const app = HttpApiBuilder.layer(LaunchApi).pipe(
    Layer.provide(ThreadLaunchHttp.layer),
    Layer.provide(auth),
    Layer.provide(services),
    Layer.provide(NodeHttpPlatform.layer),
    Layer.provide(Etag.layerWeak),
    Layer.provide(NodeServices.layer),
  );
  return { launched, ...HttpRouter.toWebHandler(app, { disableLogger: true }) };
}

const post = (handler: (request: Request) => Promise<Response>) =>
  handler(
    new Request("http://environment.test/api/orchestration/launch-thread", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
      },
      body: JSON.stringify(launchBody),
    }),
  );

it.effect("launches a thread with the caller's thread and message ids", () =>
  Effect.promise(async () => {
    const { handler, dispose, launched } = serve([AuthOrchestrationOperateScope]);
    try {
      const response = await post(handler);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), {
        threadId: "thread-from-client",
        resumed: false,
      });
      assert.strictEqual(launched.length, 1);
      assert.strictEqual(launched[0]?.threadId, "thread-from-client");
      assert.strictEqual(launched[0]?.initialMessage?.messageId, "message-1");
      assert.strictEqual(launched[0]?.createdBy, "user");
    } finally {
      await dispose();
    }
  }),
);

it.effect("refuses a caller that may only read", () =>
  Effect.promise(async () => {
    const { handler, dispose, launched } = serve([AuthOrchestrationReadScope]);
    try {
      const response = await post(handler);
      assert.strictEqual(response.status, 403);
      assert.strictEqual(launched.length, 0);
    } finally {
      await dispose();
    }
  }),
);
