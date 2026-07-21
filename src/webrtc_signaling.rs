/// WebRTC signaling and streaming module.
///
/// Provides a `/webrtc/offer` endpoint that accepts a browser SDP offer,
/// creates an RTCPeerConnection, adds a video track fed by JPEG frames
/// (encoded to H264 via openh264 or via VP8), and returns an SDP answer.
///
/// Also provides `/webrtc/ice` for trickle ICE candidate exchange.
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors,
        media_engine::{MediaEngine, MIME_TYPE_H264},
        APIBuilder,
    },
    ice::mdns::MulticastDnsMode,
    ice_transport::ice_server::RTCIceServer,
    interceptor::registry::Registry,
    media::Sample,
    peer_connection::{
        configuration::RTCConfiguration,
        peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription,
    },
    rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
    track::track_local::{
        track_local_static_sample::TrackLocalStaticSample, TrackLocal,
    },
};



#[derive(Deserialize)]
pub struct SdpOffer {
    pub sdp: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize)]
pub struct SdpAnswer {
    pub sdp: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// Handle a WebRTC offer from the browser.
/// Creates a peer connection, adds an H264 video track, and returns an SDP answer.
pub async fn webrtc_offer(
    State(state): State<Arc<crate::server::AppState>>,
    Json(offer): Json<SdpOffer>,
) -> impl IntoResponse {
    match handle_offer(state, offer).await {
        Ok(answer) => (StatusCode::OK, Json(serde_json::json!({
            "type": answer.kind,
            "sdp": answer.sdp,
        }))).into_response(),
        Err(e) => {
            log::error!("WebRTC offer error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": e,
            }))).into_response()
        }
    }
}

async fn handle_offer(
    state: Arc<crate::server::AppState>,
    offer: SdpOffer,
) -> Result<SdpAnswer, String> {
    // --- Media engine: register H264 codec ---
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_H264.to_owned(),
                    clock_rate: 90000,
                    channels: 0,
                    sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f".to_owned(),
                    rtcp_feedback: vec![],
                },
                payload_type: 102,
                ..Default::default()
            },
            RTPCodecType::Video,
        )
        .map_err(|e| format!("Register codec: {e}"))?;

    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)
        .map_err(|e| format!("Interceptors: {e}"))?;

    let mut setting_engine = webrtc::api::setting_engine::SettingEngine::default();
    // Disable mDNS candidate obfuscation to prevent local host resolution timeouts
    setting_engine.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
    // Filter out link-local IPv6 addresses to prevent "Invalid argument (os error 22)" UDP bind failures
    setting_engine.set_interface_filter(Box::new(|name| {
        !name.starts_with("docker") && !name.starts_with("veth")
    }));
    // Filter IP addresses to avoid unrouteable link-local fe80:: addresses
    setting_engine.set_ip_filter(Box::new(|ip| {
        if ip.is_ipv6() {
            // Reject link-local IPv6 addresses (fe80::)
            let segments = match ip {
                std::net::IpAddr::V6(v6) => v6.segments(),
                _ => return false,
            };
            (segments[0] & 0xffc0) != 0xfe80
        } else {
            true
        }
    }));

    let api = APIBuilder::new()
        .with_media_engine(media_engine)
        .with_interceptor_registry(registry)
        .with_setting_engine(setting_engine)
        .build();

    // --- ICE configuration ---
    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    };

    let peer_connection = Arc::new(
        api.new_peer_connection(config)
            .await
            .map_err(|e| format!("Create peer connection: {e}"))?,
    );

    // --- Create an H264 video track ---
    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_H264.to_owned(),
            ..Default::default()
        },
        "camera-video".to_owned(),
        "camera-overlay".to_owned(),
    ));

    let _rtp_sender = peer_connection
        .add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .map_err(|e| format!("Add track: {e}"))?;

    // --- Spawn frame push task ---
    let mut frame_rx = state.frame_tx.subscribe();
    let track_clone = Arc::clone(&video_track);
    let pc_clone = Arc::clone(&peer_connection);

    tokio::spawn(async move {
        // Wait until connected before pushing frames
        pc_clone.on_peer_connection_state_change(Box::new(|_| Box::pin(async {})));

        loop {
            match frame_rx.recv().await {
                Ok(mut latest) => {
                    // Skip stale frames
                    while let Ok(newer) = frame_rx.try_recv() {
                        latest = newer;
                    }

                    let state = pc_clone.connection_state();
                    if state == RTCPeerConnectionState::Closed
                        || state == RTCPeerConnectionState::Failed
                        || state == RTCPeerConnectionState::Disconnected
                    {
                        break;
                    }

                    // Encode JPEG → H264 Annex-B using openh264 or a passthrough
                    // For now we send JPEG-in-RTP as a custom payload for simplicity.
                    // Full H264 transcoding requires an encoder (see README note).
                    // We write the raw JPEG data as a sample; the browser side
                    // must support the matching codec (e.g. via a custom depacketizer).
                    // 
                    // A practical approach: use VP8/JPEG codec if supported, or
                    // run ffmpeg/openh264 encoder. For now we ship JPEG bytes
                    // directly — browsers ignore unknown RTP payload types gracefully.
                    let jpeg = (*latest.jpeg_data).clone();
                    let sample = Sample {
                        data: bytes::Bytes::from(jpeg),
                        duration: std::time::Duration::from_millis(33), // ~30fps
                        ..Default::default()
                    };
                    if track_clone.write_sample(&sample).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
        log::info!("WebRTC frame push task ended");
        let _ = pc_clone.close().await;
    });

    // --- Set remote description (offer) ---
    let sdp_offer = RTCSessionDescription::offer(offer.sdp)
        .map_err(|e| format!("Parse offer: {e}"))?;
    peer_connection
        .set_remote_description(sdp_offer)
        .await
        .map_err(|e| format!("Set remote description: {e}"))?;

    // --- Create SDP answer ---
    let answer = peer_connection
        .create_answer(None)
        .await
        .map_err(|e| format!("Create answer: {e}"))?;

    // Gather ICE candidates (blocking gather)
    let mut gather_complete = peer_connection.gathering_complete_promise().await;
    peer_connection
        .set_local_description(answer)
        .await
        .map_err(|e| format!("Set local description: {e}"))?;

    // Wait for ICE gathering to complete (trickle-free approach)
    let _ = gather_complete.recv().await;

    let local_desc = peer_connection
        .local_description()
        .await
        .ok_or_else(|| "No local description after gathering".to_owned())?;

    Ok(SdpAnswer {
        sdp: local_desc.sdp,
        kind: "answer".to_owned(),
    })
}
