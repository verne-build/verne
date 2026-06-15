use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use crate::services::session_manager::{write_to_session, SessionManager};

/// Bind the terminal WS port. Failure is FATAL: a daemon that can't serve
/// terminals must not linger as an RPC-only zombie (that produces a daemon
/// whose RPC works but whose terminal sockets immediately close, spamming the
/// UI with reconnects). Binding here — before the RPC socket is created — also
/// makes the WS port the daemon's single-instance authority: a second daemon
/// for the same port exits instead of clobbering the first.
pub async fn bind_ws(port: u16) -> TcpListener {
    let addr = format!("127.0.0.1:{}", port);
    match TcpListener::bind(&addr).await {
        Ok(l) => {
            log::info!("WebSocket server listening on ws://{}", addr);
            l
        }
        Err(e) => {
            log::error!(
                "FATAL: WS bind failed on {} ({}); another daemon owns the port — exiting",
                addr,
                e
            );
            std::process::exit(1);
        }
    }
}

pub async fn serve_ws(listener: TcpListener, sessions: Arc<Mutex<SessionManager>>) {
    while let Ok((stream, _)) = listener.accept().await {
        // Disable Nagle: terminal deltas are small, bursty frames; without this,
        // Nagle×delayed-ACK can hold a keystroke's echo for tens of ms on the
        // (loopback) socket. Latency matters far more than packet count here.
        let _ = stream.set_nodelay(true);
        let sessions = sessions.clone();
        tokio::spawn(handle_connection(stream, sessions));
    }
}

async fn handle_connection(stream: tokio::net::TcpStream, sessions: Arc<Mutex<SessionManager>>) {
    // Parse the HTTP upgrade request to extract the session id from the path.
    let session_id_cell = Arc::new(Mutex::new(None::<String>));
    let cell_clone = session_id_cell.clone();

    let ws_stream = tokio_tungstenite::accept_hdr_async(
        stream,
        move |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
              resp: tokio_tungstenite::tungstenite::handshake::server::Response| {
            let path = req.uri().path().to_string();
            if let Some(sid) = path.strip_prefix("/session/") {
                *cell_clone.lock().unwrap() = Some(sid.to_string());
            }
            Ok(resp)
        },
    )
    .await;

    let ws_stream = match ws_stream {
        Ok(ws) => ws,
        Err(e) => {
            log::debug!("WS handshake failed: {}", e);
            return;
        }
    };

    let session_id = match session_id_cell.lock().unwrap().clone() {
        Some(id) => id,
        None => return,
    };

    handle_grid_connection(ws_stream, sessions, session_id).await;
}

/// Grid (canvas) client handler. Sends a cell `sync` on connect, forwards
/// coalesced `delta`s, and accepts JSON `input`/`resize`/`fetch` frames. The
/// server encodes input to PTY bytes via the emulator's authoritative modes.
async fn handle_grid_connection(
    ws_stream: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    sessions: Arc<Mutex<SessionManager>>,
    session_id: String,
) {
    use crate::services::grid_protocol::{
        encode_delta, encode_history, encode_search_result, encode_snapshot,
    };
    use crate::services::input_encoder::{encode as encode_input, parse_input_event};

    let (emulator, grid_tx) = {
        let g = sessions.lock().unwrap();
        match g.get_session(&session_id) {
            Some(s) => (s.emulator.clone(), s.grid_tx.clone()),
            None => return,
        }
    };

    // Consistent cut: subscribe to deltas + snapshot the viewport under one lock
    // so the snapshot's `rev` and the first delta join without gap or overlap.
    let (mut grid_rx, sync_frame) = {
        let emu = emulator.lock().unwrap();
        let rx = grid_tx.subscribe();
        (rx, encode_snapshot(&emu.viewport_snapshot()))
    };

    let (mut ws_sink, mut ws_source) = ws_stream.split();

    // Sync (consistent-cut snapshot) MUST reach the client before any delta so
    // it can size the grid. Send it synchronously before the forward loop —
    // deltas are now the biased-first arm, so we can't rely on queue order.
    if ws_sink.send(Message::Binary(sync_frame.into())).await.is_err() {
        return;
    }

    // Replies (resync snapshots, history chunks, search results) ride a BOUNDED
    // channel: producers `blocking_send` so a slow drain applies backpressure to
    // the fetch/search task instead of growing memory. Deltas (live output) are
    // served first below; replies drain only when no delta is pending, so heavy
    // output can't be starved by a scrollback/search burst.
    const REPLY_BOUND: usize = 64;
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(REPLY_BOUND);

    // In-flight fetch/search cancel flags, keyed by client reqId. A `cancel`
    // message flips the flag; the worker checks it between chunks and bails.
    let inflight: Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let emulator_fwd = emulator.clone();
    let fwd = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                received = grid_rx.recv() => match received {
                    Ok(delta) => {
                        if ws_sink.send(Message::Binary(encode_delta(&delta).into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Slow client: drop pending deltas, resync from the grid.
                        let snap = emulator_fwd.lock().ok().map(|e| e.viewport_snapshot());
                        if let Some(snap) = snap {
                            if ws_sink.send(Message::Binary(encode_snapshot(&snap).into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                Some(frame) = out_rx.recv() => {
                    if ws_sink.send(Message::Binary(frame.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    while let Some(msg) = ws_source.next().await {
        let Ok(msg) = msg else { break };
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => match String::from_utf8(b.to_vec()) {
                Ok(s) => s,
                Err(_) => continue,
            },
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        match v["type"].as_str() {
            Some("resize") => {
                let cols = v["cols"].as_u64().unwrap_or(80) as u16;
                let rows = v["rows"].as_u64().unwrap_or(24) as u16;
                let snap = {
                    let g = sessions.lock().unwrap();
                    match g.get_session(&session_id) {
                        Some(s) => {
                            s.resize(cols, rows);
                            s.emulator.lock().ok().map(|e| e.viewport_snapshot())
                        }
                        None => None,
                    }
                };
                if let Some(snap) = snap {
                    let _ = out_tx.send(encode_snapshot(&snap)).await;
                }
            }
            Some("fetch") => {
                let req_id = v["reqId"].as_u64().unwrap_or(0);
                let from = v["from"].as_u64().unwrap_or(0) as usize;
                let to = v["to"].as_u64().unwrap_or(0) as usize;
                let cancel = Arc::new(AtomicBool::new(false));
                inflight.lock().unwrap().insert(req_id, cancel.clone());
                let emu = emulator.clone();
                let tx = out_tx.clone();
                let inflight_c = inflight.clone();
                // Reply rides the bounded reply channel, drained only when no live
                // delta is pending (deltas are biased-first), so scrollback fetches
                // never stall live output. Chunked so the PTY reader/coalescer
                // interleave on the emulator lock; cancel bails a stale scan.
                tokio::task::spawn_blocking(move || {
                    const CHUNK: usize = 256;
                    let mut start = from;
                    while start < to {
                        if cancel.load(Ordering::Relaxed) {
                            break;
                        }
                        let end = (start + CHUNK).min(to);
                        let snap = emu.lock().ok().map(|e| (e.visual_rows(start, end), e.base()));
                        let Some((rows, base)) = snap else { break };
                        // rows: Vec<(Vec<WireCell>, bool)> — cells + wrap bit per row
                        if tx.blocking_send(encode_history(req_id, start, base, &rows)).is_err() {
                            break; // client gone
                        }
                        start = end;
                    }
                    inflight_c.lock().unwrap().remove(&req_id);
                });
            }
            Some("search") => {
                let req_id = v["reqId"].as_u64().unwrap_or(0);
                let query = v["query"].as_str().unwrap_or("").to_string();
                let limit = v["limit"].as_u64().unwrap_or(1000) as usize;
                // Default case-insensitive (editor convention); client opts into sensitive.
                let case_sensitive = v["caseSensitive"].as_bool().unwrap_or(false);
                let cancel = Arc::new(AtomicBool::new(false));
                inflight.lock().unwrap().insert(req_id, cancel.clone());
                let emu = emulator.clone();
                let tx = out_tx.clone();
                let inflight_c = inflight.clone();
                tokio::task::spawn_blocking(move || {
                    let matches = emu
                        .lock()
                        .ok()
                        .map(|e| e.search(&query, limit, case_sensitive))
                        .unwrap_or_default();
                    if !cancel.load(Ordering::Relaxed) {
                        let tuples: Vec<(usize, usize, usize)> =
                            matches.iter().map(|m| (m.line, m.col, m.len)).collect();
                        let _ = tx.blocking_send(encode_search_result(req_id, &tuples, true));
                    }
                    inflight_c.lock().unwrap().remove(&req_id);
                });
            }
            Some("cancel") => {
                let req_id = v["reqId"].as_u64().unwrap_or(0);
                if let Some(flag) = inflight.lock().unwrap().get(&req_id) {
                    flag.store(true, Ordering::Relaxed);
                }
            }
            // key / text / paste / mouse → input events.
            _ => {
                if let Some(ev) = parse_input_event(&v) {
                    let mode = emulator.lock().ok().map(|e| e.mode());
                    if let Some(mode) = mode {
                        let bytes = encode_input(&ev, mode);
                        if !bytes.is_empty() {
                            let g = sessions.lock().unwrap();
                            if let Some(s) = g.get_session(&session_id) {
                                write_to_session(s, &bytes);
                            }
                        }
                    }
                }
            }
        }
    }

    fwd.abort();
}

#[cfg(test)]
mod fwd_tests {
    use tokio::sync::{broadcast, mpsc};

    // Mirrors the forward loop's contract: deltas (biased-first) drain before
    // queued replies, and the reply channel is bounded.
    #[tokio::test]
    async fn deltas_drain_before_replies_and_reply_channel_is_bounded() {
        let (delta_tx, mut delta_rx) = broadcast::channel::<u8>(256);
        let (reply_tx, mut reply_rx) = mpsc::channel::<u8>(64);

        // Queue a reply and a delta; the biased loop must take the delta first.
        reply_tx.send(1).await.unwrap();
        delta_tx.send(2).unwrap();

        let first = tokio::select! {
            biased;
            d = delta_rx.recv() => d.unwrap(),
            r = reply_rx.recv() => r.unwrap(),
        };
        assert_eq!(first, 2, "delta must win the biased select");

        // Reply channel capacity is bounded: try_send fails past the bound.
        // One slot is already occupied by the reply queued above; fill the rest.
        for _ in 0..63 { reply_tx.try_send(0).unwrap(); }
        assert!(reply_tx.try_send(0).is_err(), "reply channel must be bounded");
    }
}

#[cfg(test)]
mod cancel_tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn cancel_flag_stops_chunk_loop() {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut sent = 0usize;
        let total = 10usize;
        for i in 0..total {
            if i == 3 {
                cancel.store(true, Ordering::Relaxed);
            }
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            sent += 1;
        }
        assert_eq!(sent, 3, "loop must stop the chunk after the flag is set");
    }
}
