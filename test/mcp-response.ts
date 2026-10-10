import { Effect, Predicate, Schema } from "effect";

const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Json),
);

export const readMcpResponse = (response: Response) =>
  Effect.gen(function* () {
    if (
      !response.headers.get("content-type")?.startsWith("text/event-stream")
    ) {
      return yield* decodeJson(yield* Effect.promise(() => response.text()));
    }

    if (response.body === null) {
      return yield* Effect.die(new Error("MCP response has no event stream"));
    }

    const reader = response.body.getReader();

    return yield* Effect.gen(function* () {
      const decoder = new TextDecoder();
      let pending = "";
      let data: string[] = [];

      while (true) {
        const chunk = yield* Effect.promise(() => reader.read());

        if (chunk.done) {
          return yield* Effect.die(
            new Error("MCP event stream ended without a JSON-RPC response"),
          );
        }

        pending += decoder.decode(chunk.value, { stream: true });
        let newline = pending.indexOf("\n");

        while (newline !== -1) {
          const line = pending.slice(0, newline).replace(/\r$/u, "");
          pending = pending.slice(newline + 1);

          if (line === "" && data.length > 0) {
            const message = yield* decodeJson(data.join("\n"));
            data = [];

            if (
              Predicate.isObject(message) &&
              (Predicate.hasProperty(message, "result") ||
                Predicate.hasProperty(message, "error"))
            ) {
              return message;
            }
          } else if (line.startsWith("data:")) {
            data.push(line.slice(5).replace(/^ /u, ""));
          }

          newline = pending.indexOf("\n");
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => reader.cancel()).pipe(
          Effect.ensuring(Effect.sync(() => reader.releaseLock())),
        ),
      ),
    );
  });
