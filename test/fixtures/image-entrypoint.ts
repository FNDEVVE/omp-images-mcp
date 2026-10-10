import { run } from "../../src/main.ts";

// Only the external provider boundary is substituted; startup, OMP's tool,
// credential discovery, retention, HTTP serving and signal handling are real.
run(() =>
  Promise.resolve(
    Response.json({
      output: [
        {
          type: "image_generation_call",
          result:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=",
          size: "1024x1024",
          quality: "high",
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "Subprocess fixture image." }],
        },
      ],
      tools: [{ type: "image_generation", model: "fixture-image-model" }],
    }),
  ),
);
