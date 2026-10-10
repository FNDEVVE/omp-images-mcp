// @effect-diagnostics unstableApiUsage:off
import type { imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";

import {
  Array as Arr,
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Predicate,
  Ref,
} from "effect";
import type { Schema } from "effect";
import type { HttpServerResponse } from "effect/http";

type Outcome = "success" | "failure" | "auth_rejected" | "origin_rejected";

interface RequestMetadata {
  readonly tool: "generate_image" | null;
  readonly selected_model: string | null;
  readonly requested_model: string | null;
  readonly outcome: Outcome;
  readonly prompt: Readonly<Record<string, string | readonly string[]>>;
  readonly redactions: readonly string[];
}

class RequestLog extends Context.Reference<
  Ref.Ref<RequestMetadata> | undefined
>("image-service/RequestLog", { defaultValue: () => undefined }) {}

const updateMetadata = (
  update: (metadata: RequestMetadata) => RequestMetadata,
) =>
  Effect.gen(function* () {
    const state = yield* RequestLog;

    if (state !== undefined) {
      yield* Ref.update(state, update);
    }
  });

const safeLogText = (text: string, redactions: readonly string[]) => {
  let safe = text.replace(
    /data:[^\s,;]+;base64,[A-Za-z0-9+/=_-]+/giu,
    "[redacted]",
  );

  for (const secret of redactions) {
    if (secret) {
      safe = safe.replaceAll(secret, "[redacted]");
    }
  }

  return safe;
};

export const recordToolPayload = (payload: Schema.Json) =>
  updateMetadata(metadata => {
    const prompt: Record<string, string | readonly string[]> = {};
    const redactions = [...metadata.redactions];
    let requestedModel: string | null = null;

    if (Predicate.isObject(payload)) {
      if (Arr.isArray(payload.input)) {
        for (const image of payload.input) {
          if (Predicate.isObject(image) && Predicate.isString(image.data)) {
            redactions.push(
              image.data,
              image.data.replace(/^data:[^,]*,/u, ""),
            );
          }
        }
      }

      for (const field of [
        "subject",
        "action",
        "scene",
        "composition",
        "lighting",
        "style",
        "text",
      ]) {
        const value = payload[field];

        if (Predicate.isString(value)) {
          prompt[field] = value;
        }
      }

      if (Arr.isArray(payload.changes)) {
        prompt.changes = payload.changes.filter(Predicate.isString);
      }

      if (Predicate.isString(payload.model)) {
        requestedModel = payload.model;
      }
    }

    return {
      ...metadata,
      tool: "generate_image",
      outcome: "failure",
      requested_model: requestedModel,
      prompt,
      redactions,
    };
  });

export const redactImageData = (base64: string) =>
  updateMetadata(metadata => ({
    ...metadata,
    redactions: [...metadata.redactions, base64],
  }));

export const recordToolResult = (
  result: Awaited<ReturnType<typeof imageGenTool.execute>>,
) =>
  updateMetadata(metadata => ({
    ...metadata,
    selected_model: result.details
      ? result.details.provider + "/" + result.details.model
      : null,
    redactions: [
      ...metadata.redactions,
      ...(result.details?.images.map(image => image.data) ?? []),
    ],
  }));

export const markToolSuccess = updateMetadata(metadata => ({
  ...metadata,
  outcome: "success",
}));

export const recordAccessRejection = (
  outcome: "auth_rejected" | "origin_rejected",
) => updateMetadata(metadata => ({ ...metadata, outcome }));

interface RequestLogOptions {
  readonly tool: "generate_image" | null;
  readonly authentication: "authenticated" | "missing" | "invalid";
  readonly bearerToken: string;
  readonly suppliedToken: string | undefined;
}

export const withRequestLogging = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  options: RequestLogOptions,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;

    const state = yield* Ref.make<RequestMetadata>({
      tool: options.tool,
      selected_model: null,
      requested_model: null,
      outcome: "failure",
      prompt: {},
      redactions: [options.bearerToken, options.suppliedToken ?? ""],
    });

    // HTTP request scopes transfer to streamed bodies in both Effect adapters.
    // Finalize after the body/tool lifetime, not when SSE headers become ready.
    yield* Effect.addFinalizer(exit =>
      Effect.gen(function* () {
        const finished = yield* Clock.currentTimeMillis;
        const metadata = yield* Ref.get(state);
        const prompt: Record<string, string | readonly string[]> = {};

        for (const [field, value] of Object.entries(metadata.prompt)) {
          prompt[field] = Predicate.isString(value)
            ? safeLogText(value, metadata.redactions)
            : value.map(text => safeLogText(text, metadata.redactions));
        }

        yield* Effect.logInfo({
          event: "image_request",
          time: new Date(started).toISOString(),
          authentication: options.authentication,
          tool: metadata.tool,
          selected_model:
            metadata.selected_model === null
              ? null
              : safeLogText(metadata.selected_model, metadata.redactions),
          requested_model:
            metadata.requested_model === null
              ? null
              : safeLogText(metadata.requested_model, metadata.redactions),
          duration_ms: finished - started,
          outcome:
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? "failure"
              : metadata.outcome,
          prompt,
        });
      }),
    );

    return yield* effect.pipe(
      Effect.tap(response =>
        Ref.update(state, (metadata): RequestMetadata =>
          metadata.tool === null &&
          metadata.outcome !== "auth_rejected" &&
          metadata.outcome !== "origin_rejected"
            ? {
                ...metadata,
                outcome: response.status < 400 ? "success" : "failure",
              }
            : metadata,
        ),
      ),
      Effect.provideService(RequestLog, state),
    );
  });
