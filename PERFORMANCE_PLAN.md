# Preview / MJPEG Stream — Performance Optimization Plan

## 1. Problem

The config-page **preview image had high delay**. It was implemented as an
`<img src="/stream">` showing the MJPEG stream (plus a manual `/snapshot`
button). The delay was bad enough that the preview was removed in commit
`58af79d ("remove preview")`. This document analyzes the cause and lays out
the optimizations, both **implemented now** and **recommended for later**.

## 2. Root-cause analysis

The capture → encode → broadcast → HTTP → browser pipeline had three latency
sources, in order of impact:

### 2.1 In-order delivery from a deep broadcast buffer (biggest cause)
`BROADCAST_CAPACITY` was **16** and the stream used `BroadcastStream`, which
delivers frames **in order**. When the browser tab / OBS momentarily stalls
(throttling, compositing, GC, socket congestion), frames pile up in the
broadcast ring and are then rendered **in order** — so the client displays a
backlog of up to 16 stale frames. At 30 fps that is **~530 ms of visible
delay**. The existing "lag-skip" only triggers *after* the ring overflows, so
short stalls still render stale frames first.

### 2.2 Per-frame full-buffer copy in JPEG encoding
`encode_jpeg` did:
```rust
let image = ImageBuffer::<Rgb<u8>, _>::from_raw(width, height, rgb.to_vec())?;
let mut cursor = Cursor::new(&mut buf);
let mut encoder = JpegEncoder::new_with_quality(&mut cursor, quality);
encoder.encode(&image, width, height, ExtendedColorType::Rgb8)?;
```
`rgb.to_vec()` copies the **entire RGB frame** (≈2.7 MB for 720p, ≈6 MB for
1080p) on every frame, just to wrap it in an owned `ImageBuffer`. But
`JpegEncoder::encode` accepts a raw `&[u8]` and internally wraps it in a
**borrowed** view — the copy is pure waste. This affects the non-native-MJPEG
path (cameras that deliver YUYV/NV12), adding per-frame memcpy + allocation
latency and RSS churn. (`&mut Vec<u8>` is already `Write`, so the `Cursor` was
also unnecessary.)

### 2.3 No "skip-to-latest" for slow clients
The stream faithfully forwarded every buffered frame. There was no mechanism to
always emit the **newest** frame and drop intermediates, so any client that
falls behind accumulates latency instead of snapping to live.

> Note: for cameras that deliver **native MJPEG** (the common case for USB
> webcams), the capture loop already passes `frame.buffer()` straight through
> with no re-encode — so 2.2 only bites cameras that don't offer MJPEG. The
> dominant delay for *all* cameras was 2.1 + 2.3.

## 3. Implemented optimizations

### 3.1 Skip-to-latest MJPEG stream (`src/server.rs`)
Replaced the `BroadcastStream + filter_map` with a **per-connection task** that
always emits the newest frame:

```rust
tokio::spawn(async move {
    let mut rx = rx;
    loop {
        tokio::select! {
            result = rx.recv() => match result {
                Ok(mut latest) => {
                    while let Ok(newer) = rx.try_recv() { latest = newer; } // drain to newest
                    let part = latest.mjpeg_part();
                    if !part.is_empty() { if tx.send(Ok(part)).await.is_err() { break; } }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            },
            _ = tx.closed() => break, // client gone — exit even while camera idle
        }
    }
});
let body = Body::from_stream(ReceiverStream::new(rx_out));
```

After `recv()`ing a frame it drains any newer queued frames (`try_recv` loop)
and emits **only the last one**. Intermediate frames are dropped, not buffered,
so a slow client never renders a stale backlog. The handoff to the HTTP body is
a **capacity-2** mpsc, so backpressure drops to latest instead of accumulating
latency. `tx.closed()` ensures the task exits promptly when the browser/OBS
drops the connection, even while the camera is idle.

### 3.2 Smaller broadcast ring (`src/main.rs`, `src/lib.rs`)
`BROADCAST_CAPACITY`: **16 → 4**. With the skip-to-latest drain, capacity no
longer controls latency — it only bounds memory/transient jitter. 4 keeps RSS
low (≈¼ of the prior buffered-frame memory) while tolerating brief stalls.

### 3.3 Zero-copy JPEG encode (`src/camera.rs`)
`encode_jpeg` now feeds the raw `&[u8]` directly to `JpegEncoder::encode` and
writes into `&mut Vec<u8>` (no `ImageBuffer::from_raw(.., rgb.to_vec())`, no
`Cursor`). A dimension guard preserves the old "return `Err` on wrong size"
contract (`encode` itself `assert_eq!`s and would panic). This removes one
full-frame alloc + memcpy per frame on the re-encode path.

### 3.4 Low-latency preview restored (`static/config.html`)
With the backend fixed, the preview is re-added: a live `<img src="/stream">`
preview that auto-shows on Start and auto-hides on Stop, plus the manual
"Refresh Snapshot" button (`/snapshot`). The `showStreamPreview` helper notes
that the backend now drains to the latest frame.

## 4. Expected impact

| Symptom | Before | After |
|---|---|---|
| Preview delay on a momentarily-stalled tab | up to ~530 ms (16 stale frames @30fps) | ~1 frame (drains to latest) |
| Per-frame allocation on non-MJPEG cameras | 1 extra full-frame copy + `Cursor` | 0 extra copies |
| Buffered-frame memory (1080p) | ~3.2 MB (16 × ~200 KB) | ~800 KB (4 × ~200 KB) |
| Stale-frame backlog to OBS | yes (in-order) | no (skip-to-latest) |

## 5. Verification

- `cargo check` — clean
- `cargo clippy -- -D warnings` — clean (no warnings)
- `cargo test --lib` — **30/30 passed** (incl. `test_encode_jpeg_*`,
  `test_lagged_subscriber_skips_without_empty_parts`,
  `test_broadcast_pipeline_no_memory_spike`, `test_get_stream`)

Run locally to feel the difference:
```bash
cargo run
# open http://localhost:8080/config  → Start  → watch the Preview card
```

## 6. Recommended future optimizations (not yet implemented)

1. **`turbojpeg` for the re-encode path.** The pure-Rust `image` JPEG encoder
   is correct but ~3–5× slower than libturbojpeg. For cameras that don't offer
   native MJPEG, switching the re-encode to `turbojpeg` (behind a Cargo feature
   + system `libturbojpeg`) would cut encode time and raise max fps. Native
   MJPEG cameras already skip re-encode, so they won't benefit.
2. **Prefer native MJPEG passthrough.** Request `MjpegFormat` from nokhwa so
   frames arrive pre-compressed and the decode→re-encode path is never taken.
   Verify the buffer is raw JPEG bytes (as the current `source_frame_format()`
   check assumes) to avoid serving RGB mislabeled as JPEG.
3. **TCP_NODELAY on the stream socket.** MJPEG writes are small and frequent;
   disabling Nagle can shave a fraction of a frame off each multipart flush.
   Check whether hyper/axum already sets this before adding a custom layer.
4. **Lower/variable JPEG quality for preview.** Quality 75 is shared by the OBS
   stream and the preview. A configurable quality (or a separate lower-quality
   preview path) would reduce encode time and frame size → less network time.
5. **WebRTC / HLS for sub-frame latency.** MJPEG-over-`multipart/x-mixed-replace`
   in an `<img>` is simple but inherently higher-latency than a real media
   transport. For a true "live" feel, a `<video>` element fed by WebRTC or HLS
   would be a larger architectural change with much lower end-to-end latency.
6. **Benchmark harness.** Add a test that measures capture→subscriber latency
   under a simulated slow consumer to guard against latency regressions.
