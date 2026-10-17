import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as ServerConfig from "../config.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";

/**
 * Launches a thread over HTTP, the same command the WebSocket `launchThread`
 * runs, for callers without a socket: a control plane starting the first
 * thread in a server it manages.
 */
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "threadLaunch",
  Effect.fnUntraced(function* (handlers) {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const intakeContext = yield* Effect.context<
      | ThreadManagementService.ThreadManagementService
      | ThreadLaunchService.ThreadLaunchService
      | FileSystem.FileSystem
      | ServerConfig.ServerConfig
      | ServerSettings.ServerSettingsService
    >();

    return handlers.handle(
      "launch",
      Effect.fn("environment.threadLaunch.launch")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
        const result = yield* startup
          .enqueueCommand(
            ThreadMessageIntake.launchThread(
              ThreadMessageIntake.threadLaunchFromWire(args.payload),
            ).pipe(Effect.provide(intakeContext)),
          )
          .pipe(
            traceLocalHandlerWork,
            Effect.catchTags({
              ThreadManagementProviderInstanceDisabledError: () =>
                failEnvironmentInvalidRequest("invalid_command"),
            }),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_thread_launch_failed", cause),
            ),
          );
        return { threadId: result.threadId, resumed: result.resumed };
      }),
    );
  }),
);
