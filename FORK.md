# Media selection fork

Based on Motrix v2.4.5 (`6099f17c585e5accb45972283a638229f24ab64b`). This branch adds plugin-backed media selection to Add Task in the Web/Server and shared desktop UI. It is an independently maintained source modification, not an upstream release.

## Use

Install the supplied Bilibili resolver `.moext` in the modified host, grant its declared permissions, and configure a working FFmpeg executable in Motrix Media Tools. Add a single Bilibili video page URL and choose Download. A single-part result is submitted directly at the highest quality returned by the provider. A multi-part result opens the BT-style selection dialog; select parts and quality, then confirm. Each selected part becomes a separate media task with a title-based MP4 name.

A plain URL without an eligible inspection provider retains the original Add Task behavior. Cancelling the selection creates no tasks. URLs are resolved near submission time. The UI submits one part per HTTP request to avoid long-batch proxy timeouts. A selection receipt deduplicates retries within that server process and expires after ten minutes. It is not a durable cross-restart download archive.

## Build and run

The fork carries the private SDK 2.3.0-media.1 tarballs under `vendor/sdk/`; both the development and production dependency layers use these pinned local files. They do not require an unpublished npm version or a sibling SDK checkout.

With Docker BuildKit available:

```sh
docker build --build-arg TARGETARCH=amd64 -t motrix-server:media-selection .
MOTRIX_IMAGE=motrix-server:media-selection docker compose up -d
```

The standard Compose file retains the upstream volume layout. Back up the existing data directory before replacing a deployed instance. Do not point two running instances at the same data directory. Start with a separate data directory when evaluating the fork.

The fork publishes its tested linux/amd64 image to GHCR from the media-selection branch:

```sh
docker pull ghcr.io/zyphoriate/motrix-server:media-selection
MOTRIX_IMAGE=ghcr.io/zyphoriate/motrix-server:media-selection docker compose up -d
```

The workflow also publishes `media-selection-amd64` and an immutable `sha-<full-commit>` tag. The workflow summary records the registry digest. If the GHCR package is private, authenticate with `docker login ghcr.io` using a token with `read:packages`; public packages support anonymous pulls.

For an exported image archive:

```sh
docker load -i motrix-server-media-selection-linux-amd64.tar.gz
MOTRIX_IMAGE=motrix-server:media-selection-amd64 docker compose up -d
```

Bilibili plugin source and its `.moext` build artifacts are maintained at [Zyphoriate/motrix-bilibili-resolver](https://github.com/Zyphoriate/motrix-bilibili-resolver). Install the package produced by that repository's Build workflow.

Source builds require the upstream prerequisites, including the native finalize helper and FFmpeg for muxing. If Docker only provides the legacy builder, cache-mount options in the three `RUN --mount=type=cache` instructions must be removed from a local Dockerfile copy; the mount options only cache dependencies and do not change the packaged feature. Use explicit `TARGETARCH=amd64` (or the target architecture supported by your build environment). The tested image is linux/amd64; an ARM64 binary image is not supplied by this build.

## SDK contract

A site resolver declares public `<plugin-id>.inspectMedia` and `<plugin-id>.resolve` commands. Inspection returns a bounded media collection: schema version, title, distinct stable entry IDs, canonical page URLs, optional part numbers/durations, and offered quality choices. It may return null for unsupported pages. The host validates results using `MediaCollectionSchema` from the vendored SDK. Confirmation resolves selected entries through `.resolve`, then delegates progressive downloads or video/audio pairs to host-owned task creation and media pipelines.

The change adds a command convention and shared types/schemas, not unrestricted plugin access to task creation or subprocess execution. Directory authorization remains host-owned. Video and audio request headers remain separate. The shared media runtime lives independently of browser-extension connection restarts. Deliberate server engine restarts cancel and drain active media work before restarting; unexpected engine crashes are not promised to resume media segments automatically.

## Validation and limits

Validation includes focused backend/UI tests, schema and SDK tests, type checking, lint, architectural checks, production server/Web builds, and an actual Chromium renderer fixture for selecting, cancelling, changing quality, and submitting parts on desktop/mobile viewports. The fixture uses mocked transport; it is not by itself full server acceptance. Container runtime smoke evidence is retained with the build artifacts.

The full upstream test suite was attempted early and had failures; no all-tests-green claim is made. Later verification is deliberately scoped and single-worker to avoid resource exhaustion.

Bilibili availability and anonymous 1080P depend on current site responses; the implementation requests DASH with the existing anonymous lookup behavior and merges using FFmpeg. Premium/DRM content is outside scope. Automatic multipart expansion currently applies to a single page URL in Add Task, not every URL in a pasted batch. Synology-native package file-ownership proof behavior has not been extended for these media tasks; use the Docker Server distribution for this build.

## Track upstream

Keep the media-selection feature branch separate from upstream `main` and preserve an upstream remote pointing to `https://github.com/agalwood/Motrix.git`. Review upstream changes to Add Task, plugin commands, media coordinator, and server packaging when merging a new release. Do not modify the legacy `master` branch. Rebuild the SDK tarballs whenever their source contract changes, update the file dependencies/lockfile, and repeat focused validation. The maintained fork is [Zyphoriate/Motrix](https://github.com/Zyphoriate/Motrix), with changes reviewed in the media-selection feature branch.
