//! Generic RPC server loop, shared by the daemon and the sidecar.
//! Both speak the same length-prefixed JSON protocol; they differ only in their
//! state type and dispatch table. The `__subscribe_events` mode is handled here
//! (it only needs the `EventBus`); everything else is delegated to `dispatch`.
//!
//! Transport:
//! - Unix/macOS/Linux: Unix domain socket (`.sock` file)
//! - Windows: TCP loopback; the port is written to `<socket_path>.port`

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::protocol::{codec, Request, Response, ServerMessage};
use crate::state::EventBus;

pub type BoxFut = Pin<Box<dyn Future<Output = Response> + Send>>;

/// Max concurrent in-flight requests per connection.
const MAX_INFLIGHT_PER_CONN: usize = 32;

async fn write_msg<W: AsyncWriteExt + Unpin>(
    writer: &tokio::sync::Mutex<W>,
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
    #[cfg(unix)]
    serve_unix(socket_path, state, event_bus, dispatch).await;
    #[cfg(windows)]
    serve_tcp(socket_path, state, event_bus, dispatch).await;
}

// ── Unix domain socket transport ────────────────────────────────────────────

#[cfg(unix)]
async fn serve_unix<S: Send + Sync + 'static>(
    socket_path: PathBuf,
    state: Arc<S>,
    event_bus: Arc<EventBus>,
    dispatch: fn(Request, Arc<S>) -> BoxFut,
) {
    use tokio::net::UnixListener;
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).expect("bind unix socket");
    log::info!("rpc server listening on {}", socket_path.display());
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let (r, w) = stream.into_split();
                tokio::spawn(handle_client(r, w, state.clone(), event_bus.clone(), dispatch));
            }
            Err(e) => log::error!("accept err: {e}"),
        }
    }
}

// ── TCP loopback transport (Windows) ────────────────────────────────────────

#[cfg(windows)]
async fn serve_tcp<S: Send + Sync + 'static>(
    socket_path: PathBuf,
    state: Arc<S>,
    event_bus: Arc<EventBus>,
    dispatch: fn(Request, Arc<S>) -> BoxFut,
) {
    use tokio::net::TcpListener;
    // Bind to an ephemeral loopback port and publish it next to the socket path
    // so the Node.js side can read it and connect via TCP.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind tcp");
    let port = listener.local_addr().expect("local addr").port();
    let port_path = socket_path.with_extension("port");
    std::fs::write(&port_path, port.to_string()).expect("write port file");
    log::info!(
        "rpc server listening on 127.0.0.1:{port} ({})",
        port_path.display()
    );
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let (r, w) = stream.into_split();
                tokio::spawn(handle_client(r, w, state.clone(), event_bus.clone(), dispatch));
            }
            Err(e) => log::error!("accept err: {e}"),
        }
    }
}

// ── Shared connection handler ────────────────────────────────────────────────

async fn handle_client<R, W, S>(
    mut r: R,
    w: W,
    state: Arc<S>,
    event_bus: Arc<EventBus>,
    dispatch: fn(Request, Arc<S>) -> BoxFut,
) where
    R: AsyncReadExt + Unpin + Send + 'static,
    W: AsyncWriteExt + Unpin + Send + 'static,
    S: Send + Sync + 'static,
{
    let writer = Arc::new(tokio::sync::Mutex::new(w));

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

    let sem = Arc::new(tokio::sync::Semaphore::new(MAX_INFLIGHT_PER_CONN));

    let spawn_dispatch = |req: Request, permit: tokio::sync::OwnedSemaphorePermit| {
        let writer = writer.clone();
        let state = state.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let resp = dispatch(req, state).await;
            let _ = write_msg(&writer, &ServerMessage::Response(resp)).await;
        });
    };

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
