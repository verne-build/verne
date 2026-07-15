//! Generic Unix-socket RPC server loop, shared by the daemon and the sidecar.
//! Both speak the same length-prefixed JSON protocol; they differ only in their
//! state type and dispatch table. The `__subscribe_events` mode is handled here
//! (it only needs the `EventBus`); everything else is delegated to `dispatch`.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use tokio::net::UnixListener;

use crate::protocol::{codec, Request, Response, ServerMessage};
use crate::state::EventBus;

pub type BoxFut = Pin<Box<dyn Future<Output = Response> + Send>>;

/// Max concurrent in-flight requests per connection. The dispatch loop runs each
/// request on its own task (so a slow handler doesn't head-of-line block the
/// ones behind it); this caps how many run at once and applies read backpressure.
/// Handlers offload heavy blocking work (git2, fs) via spawn_blocking, so this
/// bounds dispatch concurrency without starving the async runtime.
const MAX_INFLIGHT_PER_CONN: usize = 32;

async fn write_msg(
    writer: &tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>,
    msg: &ServerMessage,
) -> Result<(), String> {
    let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    let mut w = writer.lock().await;
    codec::write_frame(&mut *w, &body).await
}

/// Serve RPC on `socket_path`. `state` is shared with every request; `dispatch`
/// turns a `Request` into a `Response`. `event_bus` backs `__subscribe_events`.
pub async fn serve<S: Send + Sync + 'static>(
    socket_path: PathBuf,
    state: Arc<S>,
    event_bus: Arc<EventBus>,
    dispatch: fn(Request, Arc<S>) -> BoxFut,
) {
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).expect("bind socket");
    log::info!("rpc server listening on {}", socket_path.display());

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let s = state.clone();
                let bus = event_bus.clone();
                tokio::spawn(handle_client(stream, s, bus, dispatch));
            }
            Err(e) => log::error!("accept err: {e}"),
        }
    }
}

async fn handle_client<S: Send + Sync + 'static>(
    stream: tokio::net::UnixStream,
    state: Arc<S>,
    event_bus: Arc<EventBus>,
    dispatch: fn(Request, Arc<S>) -> BoxFut,
) {
    let (mut r, w) = stream.into_split();
    let writer = Arc::new(tokio::sync::Mutex::new(w));

    // Read the first request to decide the mode.
    let body = match codec::read_frame(&mut r).await {
        Ok(b) => b,
        Err(_) => return,
    };
    let first_req: Request = match decode(&body) {
        Ok(r) => r,
        Err(e) => {
            let resp = Response::err(0, format!("decode: {e}"));
            let _ = write_msg(&writer, &ServerMessage::Response(resp)).await;
            return;
        }
    };

    if first_req.method == "__subscribe_events" {
        let ack = ServerMessage::Response(Response::ok(first_req.id, serde_json::Value::Null));
        if write_msg(&writer, &ack).await.is_err() {
            return;
        }
        let mut rx = event_bus.subscribe();
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    if write_msg(&writer, &ServerMessage::Event(ev)).await.is_err() {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        }
    }

    // Normal request/response mode. Each request is dispatched on its own task so
    // one slow handler doesn't head-of-line block the requests behind it on the
    // same connection (the client matches responses by id, so out-of-order
    // completion is fine; sequential client flows stay ordered because they await
    // each response before sending the next). The semaphore bounds in-flight work
    // and, by gating the read of the next frame, applies backpressure.
    let sem = Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_PER_CONN));

    let spawn_dispatch = |req: Request, permit: tokio::sync::OwnedSemaphorePermit| {
        let writer = writer.clone();
        let state = state.clone();
        tokio::spawn(async move {
            let _permit = permit; // held until the response is written
            let resp = dispatch(req, state).await;
            let _ = write_msg(&writer, &ServerMessage::Response(resp)).await;
        });
    };

    // first_req can't fail to get a permit (sem starts full); unwrap is safe
    // unless the semaphore is closed, which we never do.
    if let Ok(permit) = sem.clone().acquire_owned().await {
        spawn_dispatch(first_req, permit);
    }

    loop {
        let body = match codec::read_frame(&mut r).await {
            Ok(b) => b,
            Err(_) => return,
        };
        let req: Request = match decode(&body) {
            Ok(r) => r,
            Err(e) => {
                let resp = Response::err(0, format!("decode: {e}"));
                if write_msg(&writer, &ServerMessage::Response(resp))
                    .await
                    .is_err()
                {
                    return;
                }
                continue;
            }
        };
        // Wait for a free slot before dispatching — bounds concurrency and stops
        // us reading faster than we can serve.
        let Ok(permit) = sem.clone().acquire_owned().await else {
            return;
        };
        spawn_dispatch(req, permit);
    }
}

fn decode(body: &[u8]) -> Result<Request, String> {
    let mut buf = Vec::with_capacity(body.len() + 4);
    buf.extend_from_slice(&(body.len() as u32).to_be_bytes());
    buf.extend_from_slice(body);
    codec::decode_request(&buf)
}
