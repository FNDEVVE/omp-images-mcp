import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Predicate,
  Schedule,
} from "effect";

import type { StartupConfig } from "./image-config.ts";
import { ImageExecutionFailed, InvalidToolInput } from "./image-errors.ts";

interface GeneratedImage {
  readonly path: string;
  readonly mimeType: string;
  readonly createdAt: number;
}

const uuid =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const referencePattern = new RegExp(`^generated-image:(${uuid})$`);

const filenamePattern = new RegExp(`^(${uuid})\\.([a-z0-9][a-z0-9.+-]*)$`);

const mimePattern = /^image\/([a-z0-9][a-z0-9.+-]*)$/;

const readFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const unavailable = () =>
  new InvalidToolInput({
    message:
      "input.path generated image reference is unavailable or expired; re-upload the image.",
  });

const isAbsent = (cause: unknown) =>
  Predicate.isError(cause) &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ELOOP" || cause.code === "ENXIO");

const makeRetentionStore = (config: StartupConfig) =>
  Effect.gen(function* () {
    const directory = config.retentionDirectory;
    const retentionMilliseconds = Duration.toMillis(config.retention);
    const owner = process.getuid?.();

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const entry = await lstat(directory);

        if (!entry.isDirectory() || entry.uid !== owner) {
          throw new Error("Unsafe retention directory");
        }

        const handle = await open(directory, readFlags | constants.O_DIRECTORY);

        try {
          const opened = await handle.stat();

          if (
            !opened.isDirectory() ||
            opened.uid !== owner ||
            opened.ino !== entry.ino ||
            opened.dev !== entry.dev
          ) {
            throw new Error("Unsafe retention directory");
          }

          await handle.chmod(0o700);
        } finally {
          await handle.close();
        }
      },
      catch: () => new ImageExecutionFailed(),
    });

    const inspect = async (filename: string, now: number, read: boolean) => {
      const match = filenamePattern.exec(filename);

      if (!match) {
        return undefined;
      }

      const path = join(directory, filename);
      const handle = await open(path, readFlags);

      try {
        const file = await handle.stat();

        if (!file.isFile() || file.uid !== owner || file.nlink !== 1) {
          return undefined;
        }

        if (now - file.mtimeMs >= retentionMilliseconds) {
          await unlink(path);

          return undefined;
        }

        if (!read) {
          return undefined;
        }

        return {
          data: (await handle.readFile()).toString("base64"),
          mime_type: `image/${match[2]}`,
        };
      } finally {
        await handle.close();
      }
    };

    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      yield* Effect.tryPromise({
        try: async () => {
          for (const filename of await readdir(directory)) {
            try {
              await inspect(filename, now, false);
            } catch (error) {
              if (!isAbsent(error)) {
                throw error;
              }
            }
          }
        },
        catch: () => new ImageExecutionFailed(),
      });
    });

    yield* sweep;
    const clock = yield* Clock.Clock;
    const interval = Duration.millis(Math.min(retentionMilliseconds, 60_000));

    yield* sweep.pipe(
      Effect.catch(() => Effect.logError("Failed to sweep retained images.")),
      Effect.repeat(Schedule.spaced(interval)),
      // Only the clock is needed; never inherit a request containing uploaded bytes.
      Effect.setContext(Context.make(Clock.Clock, clock)),
      Effect.forkScoped({ startImmediately: true }),
    );

    const retainImage = (image: GeneratedImage) =>
      Effect.tryPromise({
        try: async () => {
          const mime = mimePattern.exec(image.mimeType);

          if (!mime) {
            throw new Error("Unsupported output MIME type");
          }

          const id = randomUUID();
          const destination = join(directory, `${id}.${mime[1]}`);
          const source = await open(image.path, readFlags);
          let ownsSource = false;
          let ownsDestination = false;

          try {
            const original = await source.stat();

            if (
              !original.isFile() ||
              original.uid !== owner ||
              original.nlink !== 1
            ) {
              throw new Error("Unsafe generated output");
            }

            ownsSource = true;

            try {
              await rename(image.path, destination);
              ownsSource = false;
              ownsDestination = true;
            } catch (error) {
              if (
                !(
                  Predicate.isError(error) &&
                  "code" in error &&
                  error.code === "EXDEV"
                )
              ) {
                throw error;
              }

              const target = await open(
                destination,
                constants.O_WRONLY |
                  constants.O_CREAT |
                  constants.O_EXCL |
                  constants.O_NOFOLLOW,
                0o600,
              );

              ownsDestination = true;

              try {
                const buffer = Buffer.allocUnsafe(64 * 1024);
                let bytesRead: number;

                do {
                  ({ bytesRead } = await source.read(
                    buffer,
                    0,
                    buffer.length,
                    null,
                  ));
                  let written = 0;

                  while (written < bytesRead) {
                    const result = await target.write(
                      buffer,
                      written,
                      bytesRead - written,
                      null,
                    );

                    written += result.bytesWritten;
                  }
                } while (bytesRead !== 0);

                await target.chmod(0o600);
                await target.utimes(
                  image.createdAt / 1000,
                  image.createdAt / 1000,
                );
              } finally {
                await target.close();
              }

              await unlink(image.path);
              ownsSource = false;

              return `generated-image:${id}`;
            }

            const retained = await open(destination, readFlags);

            try {
              const moved = await retained.stat();

              if (
                !moved.isFile() ||
                moved.uid !== owner ||
                moved.nlink !== 1 ||
                moved.ino !== original.ino ||
                moved.dev !== original.dev
              ) {
                throw new Error("Unsafe retained output");
              }

              await retained.chmod(0o600);
              await retained.utimes(
                image.createdAt / 1000,
                image.createdAt / 1000,
              );
            } finally {
              await retained.close();
            }

            return `generated-image:${id}`;
          } catch (error) {
            if (ownsDestination) {
              await unlink(destination);
            }

            if (ownsSource) {
              await unlink(image.path);
            }

            throw error;
          } finally {
            await source.close();
          }
        },
        catch: () => new ImageExecutionFailed(),
      }).pipe(Effect.uninterruptible);

    const resolve = (reference: string) =>
      Effect.gen(function* () {
        const match = referencePattern.exec(reference);

        if (!match) {
          return yield* unavailable();
        }

        const now = yield* Clock.currentTimeMillis;

        const image = yield* Effect.tryPromise({
          try: async () => {
            const filenames = (await readdir(directory)).filter(
              filename => filenamePattern.exec(filename)?.[1] === match[1],
            );

            if (filenames.length !== 1 || filenames[0] === undefined) {
              return undefined;
            }

            return inspect(filenames[0], now, true);
          },
          catch: unavailable,
        });

        if (image === undefined) {
          return yield* unavailable();
        }

        return image;
      });

    return { retainImage, resolve };
  });

export type RetainedImageStore = Effect.Success<
  ReturnType<typeof makeRetentionStore>
>;

export class RetentionStore extends Context.Service<
  RetentionStore,
  RetainedImageStore
>()("image-retention/RetentionStore") {}

export const layer = (config: StartupConfig) =>
  Layer.effect(RetentionStore, makeRetentionStore(config));
