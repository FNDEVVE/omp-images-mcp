# OMP Images

Remote access to OMP's image-generation and editing capability, using the host's existing provider access.

## Language

**OMP image tool**:
OMP's existing image-generation and editing tool. Its public behavior is the compatibility target for this service.
_Avoid_: image backend API, when referring to the tool itself

**OMP profile**:
The provider logins and model preferences that OMP uses on the host. The service reuses this profile rather than requiring provider credentials from callers.

**Image generation**:
An image request whose starting material is a text prompt, without supplied images.

**Image edit**:
An image request whose starting material includes supplied images. Its result is a new image, not a replacement of the originals.

**Reference image**:
A supplied image used as input to an image edit, distinct from the output image.

**Generated image reference**:
A reference to an output image produced by this module, usable as input to a later image edit while that image is retained. It does not grant access to arbitrary images on the host.
