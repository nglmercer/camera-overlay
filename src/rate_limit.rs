use axum::{
    body::Body,
    extract::{Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum::http;
use governor::{
    clock::DefaultClock,
    middleware::NoOpMiddleware,
    state::{InMemoryState, NotKeyed},
    Quota, RateLimiter,
};
use nonzero_ext::nonzero;
use std::sync::Arc;

type SharedLimiter = Arc<RateLimiter<NotKeyed, InMemoryState, DefaultClock, NoOpMiddleware>>;

#[derive(Clone)]
pub struct RateLimiters {
    /// Limit for control endpoints that mutate state or spawn threads:
    /// `/start`, `/stop`, `/settings` POST.
    pub control: SharedLimiter,
    /// Limit for data endpoints that hand out frames: `/stream`, `/snapshot`.
    pub data: SharedLimiter,
}

impl Default for RateLimiters {
    fn default() -> Self {
        Self::new()
    }
}

impl RateLimiters {
    pub fn new() -> Self {
        Self {
            // 5 req/s for control endpoints (start/stop/settings)
            control: Arc::new(RateLimiter::direct(
                Quota::per_second(nonzero!(5u32)).allow_burst(nonzero!(10u32)),
            )),
            // 10 req/s for data endpoints (stream/snapshot)
            data: Arc::new(RateLimiter::direct(
                Quota::per_second(nonzero!(10u32)).allow_burst(nonzero!(20u32)),
            )),
        }
    }
}

pub async fn rate_limit_middleware(
    State(rate_limiters): State<Arc<RateLimiters>>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    let limited = match path {
        "/start" | "/stop" | "/webrtc/offer" => Some(&rate_limiters.control),
        "/settings" if request.method() == http::Method::POST => Some(&rate_limiters.control),
        "/ws" => Some(&rate_limiters.data),
        _ => None,
    };

    if let Some(limiter) = limited {
        if limiter.check().is_err() {
            return too_many_requests();
        }
    }
    next.run(request).await
}

fn too_many_requests() -> Response {
    (
        http::StatusCode::TOO_MANY_REQUESTS,
        [("Retry-After", "1"), ("Content-Type", "application/json")],
        Body::from(r#"{"error":"rate limit exceeded, slow down"}"#),
    )
        .into_response()
}
