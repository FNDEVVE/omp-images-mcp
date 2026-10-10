# Wrap OMP's original image tool, not the low-level image client

The service exposes OMP's original `generate_image` tool by calling its exported implementation, rather than reimplementing it on top of `@oh-my-pi/pi-ai`'s lower-level `generateImage()`. The original tool already owns prompt assembly from its structured parameters, image-model and hosted-carrier selection, credential and header resolution, reference-image loading, fallback, and its three-minute deadline. Calling the low-level client would force us to copy that policy and let it drift from OMP. The cost is a dependency on `@oh-my-pi/pi-coding-agent`, pinned to the host's installed OMP version and upgraded with it because both share the OMP profile's credential store, and an in-memory session context that exists only because the tool's execution context requires one.

## Consequences

- Remote adaptation stays at the edges: generated image references stand in for host paths, and the tool's base64 results become native MCP image content instead of its original text with host-local paths.
- OMP upgrades can change the exposed tool's parameters or behavior; that is intended, since the original tool is the compatibility target.
