import { Schema } from "effect";

export class StartupError extends Schema.TaggedError<StartupError>()(
  "StartupError",
  { message: Schema.String },
) {}

export class InvalidToolInput extends Schema.TaggedError<InvalidToolInput>()(
  "InvalidToolInput",
  { message: Schema.String },
) {}

export class ImageExecutionFailed extends Schema.TaggedError<ImageExecutionFailed>()(
  "ImageExecutionFailed",
  {},
) {
  override readonly message = "Image request failed.";
}
